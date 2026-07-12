import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const NOTION_VERSION = "2026-03-11";
const MAX_DEPTH = 20;

function getCookie(req, name) {
  const header = req.headers.cookie || "";

  for (const cookie of header.split(";")) {
    const trimmed = cookie.trim();
    const index = trimmed.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key = trimmed.slice(0, index);
    const value = trimmed.slice(index + 1);

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}

function normalizeId(value) {
  return String(value || "")
    .replace(/-/g, "")
    .toLowerCase()
    .trim();
}

function compareVersions(leftVersion, rightVersion) {
  const left = String(leftVersion || "")
    .trim()
    .split(".")
    .map((part) => {
      const match = part.match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });

  const right = String(rightVersion || "")
    .trim()
    .split(".")
    .map((part) => {
      const match = part.match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });

  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index] || 0;
    const rightPart = right[index] || 0;

    if (leftPart < rightPart) {
      return -1;
    }

    if (leftPart > rightPart) {
      return 1;
    }
  }

  return 0;
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

async function notion(accessToken, path, options = {}) {
  const cleanPath = path.startsWith("/")
    ? path
    : `/${path}`;

  const url = `https://api.notion.com/v1${cleanPath}`;

  const response = await fetch(url, {
    ...options,

    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(
      `Notion ${response.status} sur ${url}: ` +
        JSON.stringify(data)
    );

    error.statusCode = response.status;
    error.notionStatus = response.status;
    error.notionData = data;

    throw error;
  }

  return data;
}

async function listAllTemplates(
  accessToken,
  dataSourceId
) {
  const templates = [];
  let startCursor;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams();
    params.set("page_size", "100");

    if (startCursor) {
      params.set("start_cursor", startCursor);
    }

    const result = await notion(
      accessToken,
      `/data_sources/${dataSourceId}/templates?${params.toString()}`,
      {
        method: "GET",
      }
    );

    templates.push(...(result.templates || []));

    hasMore = Boolean(result.has_more);
    startCursor = result.next_cursor || undefined;
  }

  return templates;
}

async function listAllBlockChildren(
  accessToken,
  blockId
) {
  const blocks = [];
  let startCursor;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams();
    params.set("page_size", "100");

    if (startCursor) {
      params.set("start_cursor", startCursor);
    }

    const result = await notion(
      accessToken,
      `/blocks/${blockId}/children?${params.toString()}`,
      {
        method: "GET",
      }
    );

    blocks.push(...(result.results || []));

    hasMore = Boolean(result.has_more);
    startCursor = result.next_cursor || undefined;
  }

  return blocks;
}

function extractRichText(richText = []) {
  return richText.map((item) => ({
    type: item?.type || null,
    plain_text: item?.plain_text || "",
    href: item?.href || null,

    annotations: {
      bold: Boolean(item?.annotations?.bold),
      italic: Boolean(item?.annotations?.italic),
      strikethrough: Boolean(
        item?.annotations?.strikethrough
      ),
      underline: Boolean(
        item?.annotations?.underline
      ),
      code: Boolean(item?.annotations?.code),
      color:
        item?.annotations?.color || "default",
    },
  }));
}

function sanitizeBlockPayload(block) {
  const type = block?.type || "unknown";
  const payload = block?.[type];

  const sanitized = {
    type,
    has_children: Boolean(block?.has_children),
  };

  if (!payload || typeof payload !== "object") {
    return sanitized;
  }

  const safePayload = {};

  const scalarKeys = [
    "color",
    "language",
    "checked",
    "expression",
    "url",
  ];

  for (const key of scalarKeys) {
    if (
      Object.prototype.hasOwnProperty.call(
        payload,
        key
      )
    ) {
      safePayload[key] = payload[key];
    }
  }

  if (Array.isArray(payload.rich_text)) {
    safePayload.rich_text = extractRichText(
      payload.rich_text
    );
  }

  if (Array.isArray(payload.caption)) {
    safePayload.caption = extractRichText(
      payload.caption
    );
  }

  if (payload.icon !== undefined) {
    safePayload.icon = payload.icon;
  }

  if (payload.style !== undefined) {
    safePayload.style = payload.style;
  }

  if (payload.type !== undefined) {
    safePayload.nested_type = payload.type;
  }

  sanitized.payload = safePayload;

  return sanitized;
}

async function readBlockTree(
  accessToken,
  parentId,
  depth = 0
) {
  const children = await listAllBlockChildren(
    accessToken,
    parentId
  );

  const result = [];

  for (const block of children) {
    const item = sanitizeBlockPayload(block);

    if (
      block.has_children &&
      depth < MAX_DEPTH
    ) {
      try {
        item.children = await readBlockTree(
          accessToken,
          block.id,
          depth + 1
        );
      } catch (error) {
        /*
          Tolérance uniquement pour un enfant
          imbriqué devenu/non lisible.

          La lecture du parent racine reste stricte,
          car son erreur survient avant cette boucle.
        */
        if (
          error?.notionStatus === 404 ||
          error?.notionStatus === 403
        ) {
          item.children_unreadable = {
            status:
              error.notionStatus,
            code:
              error?.notionData?.code || null,
          };
        } else {
          throw error;
        }
      }
    }

    result.push(item);
  }

  return result;
}
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((item) =>
      canonicalize(item)
    );
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalize(value[key]),
        ])
    );
  }

  return value;
}

function calculateFingerprint(tree) {
  return sha256(
    JSON.stringify(canonicalize(tree))
  );
}

function countBlocks(tree = []) {
  let total = 0;

  for (const block of tree) {
    total += 1;

    if (Array.isArray(block.children)) {
      total += countBlocks(block.children);
    }
  }

  return total;
}

function countBlockTypes(
  tree = [],
  accumulator = {}
) {
  for (const block of tree) {
    const type = block?.type || "unknown";

    accumulator[type] =
      (accumulator[type] || 0) + 1;

    if (Array.isArray(block.children)) {
      countBlockTypes(
        block.children,
        accumulator
      );
    }
  }

  return accumulator;
}

function buildSnapshot(tree = []) {
  return {
    recursive_block_count: countBlocks(tree),

    block_types: Object.fromEntries(
      Object.entries(
        countBlockTypes(tree, {})
      ).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    ),
  };
}

function findTemplateById(
  templates,
  expectedId
) {
  const normalizedExpected =
    normalizeId(expectedId);

  if (!normalizedExpected) {
    return null;
  }

  return (
    templates.find(
      (template) =>
        normalizeId(template?.id) ===
        normalizedExpected
    ) || null
  );
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForStableFingerprint({
  accessToken,
  templateId,
  expectedFingerprint,
  maxAttempts = 12,
  delayMs = 1500,
  requiredStableReads = 2,
}) {
  const polling = [];
  let stableReads = 0;
  let previousFingerprint = null;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt += 1
  ) {
    const tree = await readBlockTree(
      accessToken,
      templateId
    );

    const fingerprint =
      calculateFingerprint(tree);

    const snapshot = buildSnapshot(tree);

    const matchesExpected =
      fingerprint === expectedFingerprint;

    if (
      matchesExpected &&
      fingerprint === previousFingerprint
    ) {
      stableReads += 1;
    } else if (matchesExpected) {
      stableReads = 1;
    } else {
      stableReads = 0;
    }

    polling.push({
      attempt,
      fingerprint,
      matches_expected: matchesExpected,
      stable_reads: stableReads,
      snapshot,
    });

    if (
      matchesExpected &&
      stableReads >= requiredStableReads
    ) {
      return {
        stable: true,
        attempts: attempt,
        fingerprint,
        snapshot,
        polling,
      };
    }

    previousFingerprint = fingerprint;

    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }

  const last =
    polling[polling.length - 1] || null;

  return {
    stable: false,
    attempts: polling.length,
    fingerprint:
      last?.fingerprint || null,
    snapshot:
      last?.snapshot || null,
    polling,
  };
}

async function getContext(req, templateKey) {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "Variable DATABASE_URL absente dans Vercel."
    );
  }

  const workspaceId = getCookie(
    req,
    "notion_workspace_id"
  );

  if (!workspaceId) {
    const error = new Error(
      "Aucun espace Notion connecté pour cette session."
    );

    error.statusCode = 401;
    throw error;
  }

  const sql = neon(databaseUrl);

  const connectionRows = await sql`
    SELECT
      workspace_id,
      workspace_name,
      access_token
    FROM notion_connections
    WHERE workspace_id = ${workspaceId}
    LIMIT 1
  `;

  const connection = connectionRows[0];

  if (!connection?.access_token) {
    const error = new Error(
      "Connexion Notion introuvable ou expirée."
    );

    error.statusCode = 401;
    throw error;
  }

  const localRows = await sql`
    SELECT
      id,
      workspace_id,
      template_key,
      component_key,
      notion_template_id,
      notion_data_source_id,
      notion_template_name,
      installed_version,
      local_fingerprint,
      sync_status,
      locally_modified,
      conflict_detected,
      last_detected_at,
      last_synced_at
    FROM notion_workspace_templates
    WHERE workspace_id = ${workspaceId}
      AND template_key = ${templateKey}
    LIMIT 1
  `;

  const officialRows = await sql`
    SELECT
      id,
      template_key,
      component_key,
      notion_template_name,
      master_workspace_id,
      master_notion_template_id,
      master_notion_data_source_id,
      official_version,
      official_fingerprint,
      is_active,
      propagate_existing_installations,
      update_if_outdated,
      overwrite_local_changes,
      local_changes_policy
    FROM notion_official_templates
    WHERE template_key = ${templateKey}
    LIMIT 1
  `;

  return {
    sql,
    connection,
    local: localRows[0] || null,
    official: officialRows[0] || null,
  };
}

function validateSyncCandidate({
  local,
  official,
  currentFingerprint,
}) {
  if (!official) {
    return {
      allowed: false,
      status: "official_template_not_registered",
      reason:
        "Aucune référence officielle centrale.",
    };
  }

  if (!official.is_active) {
    return {
      allowed: false,
      status: "official_template_inactive",
      reason:
        "Le template officiel est désactivé.",
    };
  }

  if (!local) {
    return {
      allowed: false,
      status: "missing_local_installation",
      reason:
        "Aucune installation locale enregistrée.",
    };
  }

  if (!official.official_fingerprint) {
    return {
      allowed: false,
      status: "untracked_official_baseline",
      reason:
        "Aucun fingerprint officiel central.",
    };
  }

  if (!local.local_fingerprint) {
    return {
      allowed: false,
      status: "untracked_local_baseline",
      reason:
        "Aucune baseline locale enregistrée.",
    };
  }

  const versionComparison = compareVersions(
    local.installed_version,
    official.official_version
  );

  if (versionComparison >= 0) {
    return {
      allowed: false,
      status:
        versionComparison > 0
          ? "ahead"
          : "not_outdated",
      reason:
        versionComparison > 0
          ? "La version locale est supérieure à la version officielle."
          : "La version locale n'est pas obsolète.",
    };
  }

  if (
    currentFingerprint !==
    local.local_fingerprint
  ) {
    return {
      allowed: false,
      status: "local_changes_detected",
      reason:
        "Le contenu réel a divergé de la baseline locale.",
    };
  }

  if (
    currentFingerprint ===
    official.official_fingerprint
  ) {
    return {
      allowed: false,
      status: "inconsistent_tracking",
      reason:
        "Le contenu réel correspond déjà au fingerprint officiel alors que la version locale est obsolète.",
    };
  }

  if (
    local.locally_modified ||
    local.conflict_detected
  ) {
    return {
      allowed: false,
      status: "protected_by_local_flags",
      reason:
        "Les indicateurs locaux signalent une modification ou un conflit.",
    };
  }

  if (
    !official.propagate_existing_installations
  ) {
    return {
      allowed: false,
      status: "propagation_disabled",
      reason:
        "La propagation aux installations existantes est désactivée.",
    };
  }

  if (!official.update_if_outdated) {
    return {
      allowed: false,
      status: "update_disabled",
      reason:
        "update_if_outdated est désactivé.",
    };
  }

  if (official.overwrite_local_changes) {
    return {
      allowed: false,
      status: "unsafe_policy",
      reason:
        "La synchronisation automatique sûre refuse une politique overwrite_local_changes active.",
    };
  }

  return {
    allowed: true,
    status: "update_available",
    reason:
      "Version locale obsolète, baseline locale intacte et politique centrale compatible.",
  };
}

async function applyTemplateNatively({
  accessToken,
  targetTemplateId,
  sourceTemplateId,
}) {
  return notion(
    accessToken,
    `/pages/${targetTemplateId}`,
    {
      method: "PATCH",

      body: JSON.stringify({
        template: {
          type: "template_id",
          template_id: sourceTemplateId,
        },

        erase_content: true,
      }),
    }
  );
}

async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");

      return res
        .status(405)
        .json({
          ok: false,
          error: "Méthode non autorisée",
        });
    }

    const templateKey = String(
      req.body?.template_key || ""
    ).trim();

    if (!templateKey) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "template_key est obligatoire.",
        });
    }

    const {
      sql,
      connection,
      local,
      official,
    } = await getContext(
      req,
      templateKey
    );

    if (!local || !official) {
      return res
        .status(409)
        .json({
          ok: false,
          engine_stage: "2/6",
          template_key: templateKey,
          status: !official
            ? "official_template_not_registered"
            : "missing_local_installation",
          error:
            "Synchronisation refusée : état incomplet.",
        });
    }

    const accessToken =
      connection.access_token;

    const realTemplates =
      await listAllTemplates(
        accessToken,
        local.notion_data_source_id
      );

    const realTemplate =
      findTemplateById(
        realTemplates,
        local.notion_template_id
      );

    if (!realTemplate) {
      return res
        .status(409)
        .json({
          ok: false,
          engine_stage: "2/6",
          template_key: templateKey,
          status: "missing_template",
          error:
            "Le template local réel n'est plus détecté dans Notion.",
        });
    }

    await notion(
      accessToken,
      `/pages/${realTemplate.id}`,
      {
        method: "GET",
      }
    );

    const beforeTree =
      await readBlockTree(
        accessToken,
        realTemplate.id
      );

    const beforeFingerprint =
      calculateFingerprint(beforeTree);

    const beforeSnapshot =
      buildSnapshot(beforeTree);

    const validation =
      validateSyncCandidate({
        local,
        official,
        currentFingerprint:
          beforeFingerprint,
      });

    if (!validation.allowed) {
      return res
        .status(409)
        .json({
          ok: false,
          engine_stage: "2/6",
          message:
            "Synchronisation native refusée par les contrôles de sécurité.",
          template_key: templateKey,
          status: validation.status,
          reason: validation.reason,

          before: {
            installed_version:
              local.installed_version,

            official_version:
              official.official_version,

            stored_local_fingerprint:
              local.local_fingerprint,

            current_real_fingerprint:
              beforeFingerprint,

            official_fingerprint:
              official.official_fingerprint,

            snapshot:
              beforeSnapshot,
          },

          safety: {
            notion_write_operations: 0,
            neon_write_operations: 0,
            automatic_sync_executed: false,
          },
        });
    }

    const masterTemplateId =
      official.master_notion_template_id;

    if (!masterTemplateId) {
      return res
        .status(409)
        .json({
          ok: false,
          engine_stage: "2/6",
          status: "master_template_missing",
          error:
            "Aucun master_notion_template_id central.",
        });
    }

    /*
      Vérification supplémentaire :
      le maître officiel doit être lisible
      avec le token courant.

      Dans ton architecture actuelle, le
      workspace maître est le workspace testé.
      Pour une future architecture multi-client,
      il faudra un accès serveur dédié au maître.
    */
    await notion(
      accessToken,
      `/pages/${masterTemplateId}`,
      {
        method: "GET",
      }
    );

    /*
      Dernière vérification juste avant écriture :
      protection contre une modification locale
      intervenue entre le premier scan et le PATCH.
    */
    const preWriteTree =
      await readBlockTree(
        accessToken,
        realTemplate.id
      );

    const preWriteFingerprint =
      calculateFingerprint(preWriteTree);

    if (
      preWriteFingerprint !==
      beforeFingerprint
    ) {
      return res
        .status(409)
        .json({
          ok: false,
          engine_stage: "2/6",
          status: "concurrent_local_change",
          error:
            "Le template local a changé pendant la préparation de la synchronisation. Écriture annulée.",

          safety: {
            notion_write_operations: 0,
            neon_write_operations: 0,
            automatic_sync_executed: false,
          },
        });
    }

    const nativeApplyResponse =
      await applyTemplateNatively({
        accessToken,
        targetTemplateId:
          realTemplate.id,
        sourceTemplateId:
          masterTemplateId,
      });

    const stabilization =
      await waitForStableFingerprint({
        accessToken,
        templateId:
          realTemplate.id,
        expectedFingerprint:
          official.official_fingerprint,
      });

    if (!stabilization.stable) {
      return res
        .status(500)
        .json({
          ok: false,
          engine_stage: "2/6",
          status:
            "native_sync_verification_failed",

          error:
            "La synchronisation Notion a été acceptée, mais le fingerprint final officiel n'a pas été confirmé.",

          native_apply: {
            accepted: true,
            response_id:
              nativeApplyResponse?.id || null,
          },

          stabilization,

          safety: {
            notion_write_operations: 1,
            neon_write_operations: 0,
            tracking_updated: false,
          },
        });
    }

    /*
      Neon n'est mis à jour qu'après preuve
      du fingerprint final officiel.
    */
    const updateRows = await sql`
      UPDATE notion_workspace_templates
      SET
        installed_version =
          ${official.official_version},

        official_version =
          ${official.official_version},

        official_fingerprint =
          ${official.official_fingerprint},

        local_fingerprint =
          ${official.official_fingerprint},

        sync_status = 'current',

        locally_modified = false,

        conflict_detected = false,

        last_detected_at = now(),

        last_synced_at = now(),

        updated_at = now()

      WHERE workspace_id =
        ${connection.workspace_id}

        AND template_key =
          ${templateKey}

      RETURNING
        id,
        workspace_id,
        template_key,
        installed_version,
        local_fingerprint,
        sync_status,
        locally_modified,
        conflict_detected,
        last_detected_at,
        last_synced_at
    `;

    const updatedTracking =
      updateRows[0] || null;

    if (!updatedTracking) {
      return res
        .status(500)
        .json({
          ok: false,
          engine_stage: "2/6",
          status:
            "tracking_update_failed_after_native_sync",

          error:
            "Le template Notion a été synchronisé et vérifié, mais aucune ligne locale Neon n'a été mise à jour.",

          safety: {
            notion_write_operations: 1,
            neon_write_operations: 1,
            notion_sync_verified: true,
            tracking_updated: false,
          },
        });
    }

    return res
      .status(200)
      .json({
        ok: true,

        message:
          "Synchronisation native contrôlée réussie.",

        engine_stage: "2/6",

        notion_api_version:
          NOTION_VERSION,

        workspace: {
          id:
            connection.workspace_id,

          name:
            connection.workspace_name ||
            null,
        },

        template: {
          template_key:
            templateKey,

          component_key:
            local.component_key,

          name:
            local.notion_template_name,

          target_template_id:
            realTemplate.id,

          master_template_id:
            masterTemplateId,
        },

        versions: {
          before:
            local.installed_version,

          after:
            official.official_version,

          official:
            official.official_version,
        },

        fingerprints: {
          before:
            beforeFingerprint,

          expected_official:
            official.official_fingerprint,

          after:
            stabilization.fingerprint,

          exact_match:
            stabilization.fingerprint ===
            official.official_fingerprint,
        },

        snapshots: {
          before:
            beforeSnapshot,

          after:
            stabilization.snapshot,
        },

        native_apply: {
          accepted: true,

          erase_content: true,

          response_id:
            nativeApplyResponse?.id ||
            null,
        },

        stabilization,

        tracking: {
          updated: true,
          row:
            updatedTracking,
        },

        safety: {
          pre_write_revalidation:
            true,

          concurrent_change_check:
            true,

          notion_write_operations:
            1,

          neon_write_operations:
            1,

          fingerprint_verified_before_tracking:
            true,

          automatic_sync_executed:
            true,
        },
      });
  } catch (error) {
    console.error(
      "Erreur sync-one :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        engine_stage: "2/6",

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
/*
  Exports internes pour les tests contrôlés
  et les futurs orchestrateurs du moteur.

  Aucun impact sur l'endpoint Vercel :
  l'export default handler reste inchangé.
*/
export {
  NOTION_VERSION,
  getCookie,
  normalizeId,
  compareVersions,
  sha256,
  notion,
  listAllTemplates,
  listAllBlockChildren,
  extractRichText,
  sanitizeBlockPayload,
  readBlockTree,
  canonicalize,
  calculateFingerprint,
  countBlocks,
  countBlockTypes,
  buildSnapshot,
  findTemplateById,
  sleep,
  waitForStableFingerprint,
  getContext,
  validateSyncCandidate,
  applyTemplateNatively,
};

export default async function runSyncOne(req, res) {
  return handler(req, res);
}
