import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const NOTION_VERSION = "2026-03-11";
const MAX_DEPTH = 20;

const TEST_TEMPLATE_KEY = "student_sheet";
const SIMULATED_OFFICIAL_VERSION = "1.1.0";

/*
  MI ESPACIO DOCENTE
  TEST UPDATE_AVAILABLE
  DRY RUN STRICT

  OBJECTIF :

  Prouver qu'une installation locale intacte
  en 1.0.0 devient bien "update_available"
  lorsqu'une nouvelle référence officielle
  1.1.0 existe.

  IMPORTANT :

  Le workspace maître utilise actuellement
  le même objet Notion comme :
  - template maître officiel ;
  - template local installé.

  Nous ne pouvons donc pas modifier réellement
  le maître sans modifier simultanément le local.

  Ce test simule alors une nouvelle référence
  officielle de façon purement virtuelle.

  AUCUNE ÉCRITURE :
  - Notion : 0
  - Neon : 0
*/

function getCookie(req, name) {
  const cookieHeader =
    req.headers.cookie || "";

  const cookies = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim());

  for (const cookie of cookies) {
    const separatorIndex =
      cookie.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = cookie.slice(
      0,
      separatorIndex
    );

    const value = cookie.slice(
      separatorIndex + 1
    );

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

function compareVersions(
  leftVersion,
  rightVersion
) {
  const left =
    String(leftVersion || "")
      .trim()
      .split(".")
      .map((part) => {
        const match =
          String(part).match(/^\d+/);

        return match
          ? Number(match[0])
          : 0;
      });

  const right =
    String(rightVersion || "")
      .trim()
      .split(".")
      .map((part) => {
        const match =
          String(part).match(/^\d+/);

        return match
          ? Number(match[0])
          : 0;
      });

  const length = Math.max(
    left.length,
    right.length
  );

  for (
    let index = 0;
    index < length;
    index += 1
  ) {
    const leftPart =
      left[index] || 0;

    const rightPart =
      right[index] || 0;

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

async function notion(
  accessToken,
  path,
  options = {}
) {
  const cleanPath =
    path.startsWith("/")
      ? path
      : `/${path}`;

  const url =
    `https://api.notion.com/v1${cleanPath}`;

  const response = await fetch(url, {
    ...options,

    headers: {
      Authorization:
        `Bearer ${accessToken}`,

      "Notion-Version":
        NOTION_VERSION,

      "Content-Type":
        "application/json",

      ...(options.headers || {}),
    },
  });

  const text =
    await response.text();

  let data;

  try {
    data = text
      ? JSON.parse(text)
      : {};
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    const error = new Error(
      `Notion ${response.status} ` +
      `sur ${url}: ` +
      `${JSON.stringify(data)}`
    );

    error.statusCode =
      response.status;

    throw error;
  }

  return data;
}

async function getContext(req) {
  const databaseUrl =
    process.env.DATABASE_URL;

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
      "Aucun espace Notion connecté " +
      "pour cette session."
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

  const connection =
    connectionRows[0];

  if (
    !connection ||
    !connection.access_token
  ) {
    const error = new Error(
      "Connexion Notion introuvable " +
      "ou expirée."
    );

    error.statusCode = 401;

    throw error;
  }

  const localRows = await sql`
    SELECT
      workspace_id,
      template_key,
      component_key,
      notion_template_id,
      notion_data_source_id,
      notion_template_name,
      installed_version,
      local_fingerprint,
      sync_status,
      is_default,
      locally_modified,
      conflict_detected
    FROM notion_workspace_templates
    WHERE workspace_id = ${workspaceId}
      AND template_key = ${TEST_TEMPLATE_KEY}
    LIMIT 1
  `;

  const officialRows = await sql`
    SELECT
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
    WHERE template_key = ${TEST_TEMPLATE_KEY}
    LIMIT 1
  `;

  return {
    connection,
    local: localRows[0] || null,
    official:
      officialRows[0] || null,
  };
}

async function listAllTemplates(
  accessToken,
  dataSourceId
) {
  const templates = [];

  let startCursor;
  let hasMore = true;

  while (hasMore) {
    const params =
      new URLSearchParams();

    params.set(
      "page_size",
      "100"
    );

    if (startCursor) {
      params.set(
        "start_cursor",
        startCursor
      );
    }

    const result = await notion(
      accessToken,
      (
        `/data_sources/` +
        `${dataSourceId}/templates?` +
        params.toString()
      ),
      {
        method: "GET",
      }
    );

    templates.push(
      ...(result.templates || [])
    );

    hasMore =
      Boolean(result.has_more);

    startCursor =
      result.next_cursor ||
      undefined;
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
    const params =
      new URLSearchParams();

    params.set(
      "page_size",
      "100"
    );

    if (startCursor) {
      params.set(
        "start_cursor",
        startCursor
      );
    }

    const result = await notion(
      accessToken,
      (
        `/blocks/${blockId}/children?` +
        params.toString()
      ),
      {
        method: "GET",
      }
    );

    blocks.push(
      ...(result.results || [])
    );

    hasMore =
      Boolean(result.has_more);

    startCursor =
      result.next_cursor ||
      undefined;
  }

  return blocks;
}

function extractRichText(
  richText = []
) {
  return richText.map((item) => ({
    type:
      item?.type || null,

    plain_text:
      item?.plain_text || "",

    href:
      item?.href || null,

    annotations: {
      bold:
        Boolean(
          item?.annotations?.bold
        ),

      italic:
        Boolean(
          item?.annotations?.italic
        ),

      strikethrough:
        Boolean(
          item?.annotations
            ?.strikethrough
        ),

      underline:
        Boolean(
          item?.annotations?.underline
        ),

      code:
        Boolean(
          item?.annotations?.code
        ),

      color:
        item?.annotations?.color ||
        "default",
    },
  }));
}

function sanitizeBlockPayload(
  block
) {
  const type =
    block?.type || "unknown";

  const payload =
    block?.[type];

  const sanitized = {
    type,
    has_children:
      Boolean(block?.has_children),
  };

  if (
    !payload ||
    typeof payload !== "object"
  ) {
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
      Object.prototype
        .hasOwnProperty.call(
          payload,
          key
        )
    ) {
      safePayload[key] =
        payload[key];
    }
  }

  if (
    Array.isArray(payload.rich_text)
  ) {
    safePayload.rich_text =
      extractRichText(
        payload.rich_text
      );
  }

  if (
    Array.isArray(payload.caption)
  ) {
    safePayload.caption =
      extractRichText(
        payload.caption
      );
  }

  if (
    payload.icon !== undefined
  ) {
    safePayload.icon =
      payload.icon;
  }

  if (
    payload.style !== undefined
  ) {
    safePayload.style =
      payload.style;
  }

  if (
    payload.type !== undefined
  ) {
    safePayload.nested_type =
      payload.type;
  }

  sanitized.payload =
    safePayload;

  return sanitized;
}

async function readBlockTree(
  accessToken,
  parentId,
  depth = 0
) {
  const children =
    await listAllBlockChildren(
      accessToken,
      parentId
    );

  const result = [];

  for (const block of children) {
    const item =
      sanitizeBlockPayload(
        block
      );

    if (
      block.has_children &&
      depth < MAX_DEPTH
    ) {
      item.children =
        await readBlockTree(
          accessToken,
          block.id,
          depth + 1
        );
    }

    result.push(item);
  }

  return result;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(
      (item) => canonicalize(item)
    );
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalize(
            value[key]
          ),
        ])
    );
  }

  return value;
}

function calculateFingerprint(tree) {
  return sha256(
    JSON.stringify(
      canonicalize(tree)
    )
  );
}

function countBlocks(tree = []) {
  let total = 0;

  for (const block of tree) {
    total += 1;

    if (
      Array.isArray(block.children)
    ) {
      total += countBlocks(
        block.children
      );
    }
  }

  return total;
}

function countBlockTypes(
  tree = [],
  accumulator = {}
) {
  for (const block of tree) {
    const type =
      block?.type || "unknown";

    accumulator[type] =
      (
        accumulator[type] || 0
      ) + 1;

    if (
      Array.isArray(block.children)
    ) {
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
    recursive_block_count:
      countBlocks(tree),

    block_types:
      Object.fromEntries(
        Object.entries(
          countBlockTypes(
            tree,
            {}
          )
        ).sort(
          ([left], [right]) =>
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

  return (
    templates.find(
      (template) =>
        normalizeId(template?.id) ===
        normalizedExpected
    ) || null
  );
}

/*
  Génère un fingerprint officiel simulé
  déterministe.

  Il doit :
  - être différent du fingerprint actuel ;
  - rester stable entre deux appels ;
  - ne rien écrire.

  Il représente virtuellement le contenu
  d'une future version 1.1.0.
*/
function buildSimulatedOfficialFingerprint({
  templateKey,
  currentOfficialFingerprint,
}) {
  return sha256(
    JSON.stringify({
      simulation:
        "mi-espacio-docente-update-available",

      template_key:
        templateKey,

      simulated_version:
        SIMULATED_OFFICIAL_VERSION,

      previous_official_fingerprint:
        currentOfficialFingerprint,
    })
  );
}

export default async function handler(
  req,
  res
) {
  try {
    if (req.method !== "GET") {
      res.setHeader(
        "Allow",
        "GET"
      );

      return res
        .status(405)
        .send(
          "Méthode non autorisée"
        );
    }

    const {
      connection,
      local,
      official,
    } = await getContext(req);

    if (!local) {
      return res
        .status(409)
        .json({
          ok: false,
          dry_run: true,
          error:
            "Installation locale student_sheet introuvable.",
        });
    }

    if (!official) {
      return res
        .status(409)
        .json({
          ok: false,
          dry_run: true,
          error:
            "Référence officielle student_sheet introuvable.",
        });
    }

    if (
      !official.official_fingerprint
    ) {
      return res
        .status(409)
        .json({
          ok: false,
          dry_run: true,
          error:
            "Le fingerprint officiel actuel est absent.",
        });
    }

    if (!local.local_fingerprint) {
      return res
        .status(409)
        .json({
          ok: false,
          dry_run: true,
          error:
            "Le fingerprint local enregistré est absent.",
        });
    }

    const accessToken =
      connection.access_token;

    const templates =
      await listAllTemplates(
        accessToken,
        local.notion_data_source_id
      );

    const realTemplate =
      findTemplateById(
        templates,
        local.notion_template_id
      );

    if (!realTemplate) {
      return res
        .status(409)
        .json({
          ok: false,
          dry_run: true,
          error:
            "Le template réel local n'a pas été détecté par son ID.",
        });
    }

    const page =
      await notion(
        accessToken,
        `/pages/${realTemplate.id}`,
        {
          method: "GET",
        }
      );

    const tree =
      await readBlockTree(
        accessToken,
        realTemplate.id
      );

    const currentLocalFingerprint =
      calculateFingerprint(tree);

    const simulatedOfficialFingerprint =
      buildSimulatedOfficialFingerprint({
        templateKey:
          TEST_TEMPLATE_KEY,

        currentOfficialFingerprint:
          official.official_fingerprint,
      });

    const versionComparison =
      compareVersions(
        local.installed_version,
        SIMULATED_OFFICIAL_VERSION
      );

    const versionOutdated =
      versionComparison < 0;

    const currentMatchesStoredLocal =
      currentLocalFingerprint ===
      local.local_fingerprint;

    const currentMatchesCurrentOfficial =
      currentLocalFingerprint ===
      official.official_fingerprint;

    const currentMatchesSimulatedOfficial =
      currentLocalFingerprint ===
      simulatedOfficialFingerprint;

    const simulatedOfficialDiffers =
      simulatedOfficialFingerprint !==
      official.official_fingerprint;

    const policyAllowsUpdate =
      Boolean(
        official.is_active &&
        official
          .propagate_existing_installations &&
        official.update_if_outdated
      );

    /*
      Même règle centrale que update.js V2 :

      update_available seulement si :
      - version obsolète ;
      - template réel inchangé depuis la
        dernière baseline locale ;
      - propagation existante autorisée ;
      - update_if_outdated autorisé.
    */
    const updateAvailable =
      Boolean(
        versionOutdated &&
        currentMatchesStoredLocal &&
        policyAllowsUpdate
      );

    const status =
      updateAvailable
        ? "update_available"
        : "test_failed";

    const recommendedAction =
      updateAvailable
        ? {
            action:
              "native_sync_candidate",

            automatic_sync_allowed:
              true,

            requires_user_action:
              false,
          }
        : {
            action:
              "inspect_test_preconditions",

            automatic_sync_allowed:
              false,

            requires_user_action:
              true,
          };

    return res
      .status(200)
      .json({
        ok:
          updateAvailable,

        message:
          updateAvailable
            ? (
                "Test update_available réussi. " +
                "Une installation locale intacte " +
                "en version antérieure est bien " +
                "candidate à une synchronisation native."
              )
            : (
                "Test update_available non validé. " +
                "Au moins une précondition de sécurité " +
                "n'est pas satisfaite."
              ),

        test:
          "update_available",

        engine_stage:
          "1/6",

        dry_run: true,

        notion_api_version:
          NOTION_VERSION,

        workspace: {
          id:
            connection.workspace_id,

          name:
            connection.workspace_name ||
            null,
        },

        target: {
          template_key:
            local.template_key,

          component_key:
            local.component_key,

          name:
            local.notion_template_name,

          template_id:
            realTemplate.id,

          data_source_id:
            local.notion_data_source_id,

          page_readable:
            Boolean(page?.id),
        },

        real_state_before_simulation: {
          versions: {
            official:
              official.official_version,

            installed:
              local.installed_version,
          },

          fingerprints: {
            official:
              official.official_fingerprint,

            stored_local:
              local.local_fingerprint,

            current_local:
              currentLocalFingerprint,
          },

          current_matches_official:
            currentMatchesCurrentOfficial,

          current_matches_stored_local:
            currentMatchesStoredLocal,
        },

        virtual_official_update: {
          simulated: true,

          persisted: false,

          official_version_before:
            official.official_version,

          official_version_simulated:
            SIMULATED_OFFICIAL_VERSION,

          official_fingerprint_before:
            official.official_fingerprint,

          official_fingerprint_simulated:
            simulatedOfficialFingerprint,

          simulated_fingerprint_differs:
            simulatedOfficialDiffers,

          current_matches_simulated_official:
            currentMatchesSimulatedOfficial,
        },

        versions: {
          official:
            SIMULATED_OFFICIAL_VERSION,

          installed:
            local.installed_version,

          comparison:
            versionComparison,

          outdated:
            versionOutdated,
        },

        three_way_comparison: {
          simulated_official_fingerprint:
            simulatedOfficialFingerprint,

          stored_local_fingerprint:
            local.local_fingerprint,

          current_real_local_fingerprint:
            currentLocalFingerprint,

          current_matches_stored_local:
            currentMatchesStoredLocal,

          current_matches_simulated_official:
            currentMatchesSimulatedOfficial,
        },

        policy: {
          is_active:
            official.is_active,

          propagate_existing_installations:
            official
              .propagate_existing_installations,

          update_if_outdated:
            official.update_if_outdated,

          overwrite_local_changes:
            official
              .overwrite_local_changes,

          local_changes_policy:
            official.local_changes_policy,

          allows_update:
            policyAllowsUpdate,
        },

        snapshot:
          buildSnapshot(tree),

        status,

        reason:
          updateAvailable
            ? (
                "La version installée est obsolète, " +
                "le template réel correspond exactement " +
                "au dernier fingerprint local connu et " +
                "la politique centrale autorise la mise à jour."
              )
            : (
                "La simulation n'a pas satisfait toutes " +
                "les conditions de update_available."
              ),

        recommended_action:
          recommendedAction,

        assertions: {
          local_template_exists:
            Boolean(realTemplate),

          local_page_readable:
            Boolean(page?.id),

          installed_version_is_outdated:
            versionOutdated,

          current_matches_stored_local:
            currentMatchesStoredLocal,

          simulated_official_fingerprint_differs:
            simulatedOfficialDiffers,

          current_does_not_match_simulated_official:
            !currentMatchesSimulatedOfficial,

          policy_allows_existing_update:
            policyAllowsUpdate,

          final_status_is_update_available:
            status ===
            "update_available",

          automatic_sync_allowed:
            recommendedAction
              .automatic_sync_allowed ===
            true,
        },

        safety: {
          notion_write_operations: 0,
          neon_write_operations: 0,
          templates_modified: 0,
          pages_modified: 0,
          official_registry_modified: false,
          local_tracking_modified: false,
          automatic_sync_executed: false,
        },
      });
  } catch (error) {
    console.error(
      "Erreur test update_available :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        test:
          "update_available",

        engine_stage:
          "1/6",

        dry_run: true,

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
