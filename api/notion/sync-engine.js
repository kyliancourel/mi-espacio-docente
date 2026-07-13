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

function incrementPatchVersion(version) {
  const parts = String(version || "1.0.0")
    .split(".")
    .map((part) => {
      const match = String(part).match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });

  while (parts.length < 3) {
    parts.push(0);
  }

  parts[2] += 1;

  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

async function scanTemplate({
  accessToken,
  notionDataSourceId,
  notionTemplateId,
}) {
  const templates = await listAllTemplates(
    accessToken,
    notionDataSourceId
  );

  const template = findTemplateById(
    templates,
    notionTemplateId
  );
  
  if (!template) {
    return {
      found: false,
      template: null,
      tree: null,
      fingerprint: null,
      snapshot: null,
    };
  }

  await notion(
    accessToken,
    `/pages/${template.id}`,
    {
      method: "GET",
    }
  );

    const tree = await readBlockTree(
    accessToken,
    template.id
  );

  return {
    found: true,
    template,
    tree,
    fingerprint: calculateFingerprint(tree),
    snapshot: buildSnapshot(tree),
  };
}

async function publishTemplate(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");

      return res.status(405).json({
        ok: false,
        error: "Méthode non autorisée",
      });
    }

    const templateKey = String(
      req.body?.template_key || ""
    ).trim();

    if (!templateKey) {
      return res.status(400).json({
        ok: false,
        error:
          "template_key est obligatoire.",
      });
    }

    const {
      sql,
      connection,
      official,
    } = await getContext(
      req,
      templateKey
    );

    if (!official) {
      const error = new Error(
        `Template officiel introuvable : ${templateKey}`
      );

      error.statusCode = 404;

      throw error;
    }

    if (!official.is_active) {
      const error = new Error(
        "Le template officiel est désactivé."
      );

      error.statusCode = 409;

      throw error;
    }

    if (
      official.master_workspace_id &&
      official.master_workspace_id !==
        connection.workspace_id
    ) {
      return res.status(409).json({
        ok: false,

        engine_stage: "3/6",

        status: "wrong_workspace",

        error:
          "Publication refusée hors du workspace maître.",
      });
    }

    if (
      !official.master_notion_template_id ||
      !official.master_notion_data_source_id
    ) {
      return res.status(409).json({
        ok: false,

        engine_stage: "3/6",

        status: "official_reference_incomplete",

        error:
          "Référence officielle incomplète.",
      });
    }

    const scan = await scanTemplate({
      accessToken: connection.access_token,
      notionDataSourceId:
        official.master_notion_data_source_id,
      notionTemplateId:
        official.master_notion_template_id,
    });

    if (!scan.found) {
      return res.status(409).json({
        ok: false,
        engine_stage: "3/6",
        status:
          "master_template_not_detected",
        error:
          "Le template maître officiel n'est plus détecté dans Notion.",
      });
    }

    const masterTemplate = scan.template;
    const currentFingerprint =
      scan.fingerprint;
    const currentSnapshot = scan.snapshot;

    const previousFingerprint =
      official.official_fingerprint;

    const previousVersion =
      official.official_version;

    /*
      Si le fingerprint n'a pas changé,
      aucune nouvelle version n'est publiée.
    */
    if (
      currentFingerprint ===
      previousFingerprint
    ) {
      return res.status(200).json({
        ok: true,

        engine_stage: "3/6",

        status: "already_current",

        message:
          "Le template officiel est déjà à jour.",

        workspace: {
          id: connection.workspace_id,
          name:
            connection.workspace_name ||
            null,
        },

        template: {
          template_key:
            official.template_key,

          component_key:
            official.component_key,

          name:
            official.notion_template_name,

          template_id:
            masterTemplate.id,
        },

        version: {
          current:
            previousVersion,
        },

        fingerprint: {
          current:
            currentFingerprint,
        },

        safety: {
          notion_write_operations: 0,
          neon_write_operations: 0,
          official_registry_modified: false,
        },
      });
    }

    /*
      Nouveau fingerprint détecté.
      On prépare une nouvelle version.
    */
    const nextVersion =
      incrementPatchVersion(
        previousVersion
      );

    /*
      Mise à jour du registre officiel.
    */
    const updatedRows = await sql`
      UPDATE notion_official_templates
      SET
        official_version = ${nextVersion},
        official_fingerprint = ${currentFingerprint},
        updated_at = now()

      WHERE id = ${official.id}
        AND official_fingerprint = ${previousFingerprint}

      RETURNING
        id,
        template_key,
        component_key,
        notion_template_name,
        master_workspace_id,
        master_notion_template_id,
        master_notion_data_source_id,
        official_version,
        official_fingerprint,
        updated_at
    `;

    const published = updatedRows[0] || null;

    if (!published) {
      return res.status(409).json({
        ok: false,

        engine_stage: "3/6",

        status: "publication_conflict",

        error:
          "Une autre publication a été effectuée pendant cette opération. Rechargez puis republiez."
      });
    }

    /*
      Relecture immédiate afin de prouver
      que Neon contient bien la nouvelle
      version officielle.
    */
    const verificationRows = await sql`
      SELECT
        official_version,
        official_fingerprint,
        updated_at

      FROM notion_official_templates

      WHERE id = ${official.id}

      LIMIT 1
    `;

    const verification =
      verificationRows[0];

    if (
      !verification ||
      verification.official_version !==
        nextVersion ||
      verification.official_fingerprint !==
        currentFingerprint
    ) {
      return res.status(500).json({
        ok: false,

        engine_stage: "3/6",

        status:
          "publication_verification_failed",

        error:
          "La publication n'a pas pu être vérifiée après écriture.",
      });
    }

    /*
      Construction de la réponse officielle
      de publication.
    */
    return res.status(200).json({
      ok: true,

      engine_stage: "3/6",

      status: "published",

      message:
        "Le template officiel a été publié avec succès.",

      notion_api_version:
        NOTION_VERSION,

      workspace: {
        id: connection.workspace_id,

        name:
          connection.workspace_name ||
          null,
      },

      template: {
        template_key:
          published.template_key,

        component_key:
          published.component_key,

        name:
          published.notion_template_name,

        master_workspace_id:
          published.master_workspace_id,

        master_template_id:
          published.master_notion_template_id,

        master_data_source_id:
          published.master_notion_data_source_id,
      },

      publication: {
        previous_version:
          previousVersion,

        published_version:
          nextVersion,

        previous_fingerprint:
          previousFingerprint,

        published_fingerprint:
          currentFingerprint,

        snapshot:
          currentSnapshot,

        fingerprint_changed:
          previousFingerprint !==
          currentFingerprint,

        version_incremented:
          previousVersion !==
          nextVersion,
      },

      verification: {
        registry_updated: true,

        official_version:
          verification.official_version,

        official_fingerprint:
          verification.official_fingerprint,

        fingerprint_verified:
          verification.official_fingerprint ===
          currentFingerprint,

        version_verified:
          verification.official_version ===
          nextVersion,
      },

      safety: {
        notion_write_operations: 0,

        neon_write_operations: 1,

        official_registry_modified: true,

        user_workspace_modified: false,

        user_templates_modified: false,

        automatic_sync_executed: false,
      },
    });
  } catch (error) {
    console.error(
      "Erreur publish-template :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        engine_stage: "3/6",

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
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

async function checkUpdates(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");

      return res.status(405).json({
        ok: false,
        error: "Méthode non autorisée",
      });
    }

    const templateKey = String(
      req.body?.template_key || ""
    ).trim();

    if (!templateKey) {
      return res.status(400).json({
        ok: false,
        error:
          "template_key est obligatoire.",
      });
    }

    const {
      connection,
      local,
      official,
    } = await getContext(
      req,
      templateKey
    );

    if (!local || !official) {
      return res.status(409).json({
        ok: false,
        engine_stage: "1/6",
        template_key: templateKey,
        status: !official
          ? "official_template_not_registered"
          : "missing_local_installation",
        error:
          "Vérification impossible : état incomplet.",
      });
    }

    const scan = await scanTemplate({
      accessToken: connection.access_token,
      notionDataSourceId:
        local.notion_data_source_id,
      notionTemplateId:
        local.notion_template_id,
    });

    if (!scan.found) {
      return res.status(409).json({
        ok: false,
        engine_stage: "1/6",
        template_key: templateKey,
        status: "missing_template",
        error:
          "Le template local réel n'est plus détecté dans Notion.",
      });
    }

    const validation =
      validateSyncCandidate({
        local,
        official,
        currentFingerprint:
          scan.fingerprint,
      });

    return res.status(200).json({
      ok: true,

      engine_stage: "1/6",

      template_key: templateKey,

      status: validation.status,

      update_available:
        validation.allowed,

      reason: validation.reason,

      versions: {
        installed:
          local.installed_version,

        official:
          official.official_version,
      },

      fingerprints: {
        stored_local:
          local.local_fingerprint,

        current_real:
          scan.fingerprint,

        official:
          official.official_fingerprint,
      },

      snapshot:
        scan.snapshot,

      safety: {
        notion_write_operations: 0,
        neon_write_operations: 0,
        automatic_sync_executed: false,
      },
    });
  } catch (error) {
    console.error(
      "Erreur check-updates :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        engine_stage: "1/6",

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
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

async function syncTemplate({
  sql,
  connection,
  local,
  official,
  templateKey,
}) {
  const accessToken =
    connection.access_token;

  const beforeScan = await scanTemplate({
    accessToken,
    notionDataSourceId:
      local.notion_data_source_id,
    notionTemplateId:
      local.notion_template_id,
  });

  if (!beforeScan.found) {
    return {
      ok: false,
      engine_stage: "4/6",
      template_key: templateKey,
      status: "missing_template",
      error:
        "Le template local réel n'est plus détecté dans Notion.",
      safety: {
        notion_write_operations: 0,
        neon_write_operations: 0,
        automatic_sync_executed: false,
      },
    };
  }

  const validation =
    validateSyncCandidate({
      local,
      official,
      currentFingerprint:
        beforeScan.fingerprint,
    });

  if (!validation.allowed) {
    return {
      ok: false,
      engine_stage: "4/6",
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
          beforeScan.fingerprint,

        official_fingerprint:
          official.official_fingerprint,

        snapshot:
          beforeScan.snapshot,
      },

      safety: {
        notion_write_operations: 0,
        neon_write_operations: 0,
        automatic_sync_executed: false,
      },
    };
  }

  const masterTemplateId =
    official.master_notion_template_id;

  if (!masterTemplateId) {
    return {
      ok: false,
      engine_stage: "4/6",
      status: "master_template_missing",
      error:
        "Aucun master_notion_template_id central.",
    };
  }

  await notion(
    accessToken,
    `/pages/${masterTemplateId}`,
    {
      method: "GET",
    }
  );

  const preWriteScan = await scanTemplate({
    accessToken,
    notionDataSourceId:
      local.notion_data_source_id,
    notionTemplateId:
      beforeScan.template.id,
  });

  if (
    !preWriteScan.found ||
    preWriteScan.fingerprint !==
      beforeScan.fingerprint
  ) {
    return {
      ok: false,
      engine_stage: "4/6",
      status: "concurrent_local_change",
      error:
        "Le template local a changé pendant la préparation de la synchronisation. Écriture annulée.",

      safety: {
        notion_write_operations: 0,
        neon_write_operations: 0,
        automatic_sync_executed: false,
      },
    };
  }

  const nativeApplyResponse =
    await applyTemplateNatively({
      accessToken,
      targetTemplateId:
        beforeScan.template.id,
      sourceTemplateId:
        masterTemplateId,
    });

  const stabilization =
    await waitForStableFingerprint({
      accessToken,
      templateId:
        beforeScan.template.id,
      expectedFingerprint:
        official.official_fingerprint,
    });

  if (!stabilization.stable) {
    return {
      ok: false,
      engine_stage: "4/6",
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
    };
  }

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

      AND notion_template_id =
      ${local.notion_template_id}

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
    return {
      ok: false,
      engine_stage: "4/6",
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
    };
  }

  return {
    ok: true,

    message:
      "Synchronisation native contrôlée réussie.",

    engine_stage: "4/6",

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
        beforeScan.template.id,

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
        beforeScan.fingerprint,

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
        beforeScan.snapshot,

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
  };
}

async function runSyncOne(req, res) {
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
          engine_stage: "4/6",
          template_key: templateKey,
          status: !official
            ? "official_template_not_registered"
            : "missing_local_installation",
          error:
            "Synchronisation refusée : état incomplet.",
        });
    }

    const report = await syncTemplate({
      sql,
      connection,
      local,
      official,
      templateKey,
    });

    if (report.ok) {
      return res
        .status(200)
        .json(report);
    }

    const statusCode = [
      "native_sync_verification_failed",
      "tracking_update_failed_after_native_sync",
    ].includes(report.status)
      ? 500
      : 409;

    return res
      .status(statusCode)
      .json(report);
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

        engine_stage: "4/6",

        error:
          error.message ||
          "Erreur interne du serveur.",
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
          engine_stage: "4/6",
          template_key: templateKey,
          status: !official
            ? "official_template_not_registered"
            : "missing_local_installation",
          error:
            "Synchronisation refusée : état incomplet.",
        });  
}

const report = await syncTemplate({
      sql,
      connection,
      local,
      official,
      templateKey,
    });

  if (report.ok) {
      return res
        .status(200)
        .json(report);
    }

    const statusCode = [
      "native_sync_verification_failed",
      "tracking_update_failed_after_native_sync",
    ].includes(report.status)
      ? 500
      : 409;

    return res
      .status(statusCode)
      .json(report);
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

        engine_stage: "4/6",

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
  
async function syncOne(req, res) {
  return runSyncOne(req, res);
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
  syncTemplate,
  syncWorkspace,
  scanTemplate,
  publishTemplate,
  checkUpdates,
  syncOne,
  incrementPatchVersion,
};

export default syncOne;
