import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const NOTION_VERSION = "2026-03-11";
const MAX_DEPTH = 20;

const TEST_TEMPLATE_KEY = "student_sheet";
const SIMULATED_OFFICIAL_VERSION = "1.1.0";

/*
  MI ESPACIO DOCENTE
  TEST LOCAL_CHANGES_DETECTED
  DRY RUN STRICT

  OBJECTIF :

  Prouver qu'une installation locale modifiée
  n'est jamais écrasée automatiquement lorsqu'une
  nouvelle version officielle existe.

  SIMULATION :

  1. Le template réel local est lu.
  2. Son fingerprint réel est calculé.
  3. Une nouvelle référence officielle 1.1.0
     est simulée virtuellement.
  4. Une divergence locale est simulée
     virtuellement.
  5. Le moteur doit retourner :

     status = local_changes_detected

     automatic_sync_allowed = false

     requires_user_action = true

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
    local:
      localRows[0] || null,
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
  Nouvelle référence officielle virtuelle.

  Elle représente une future version 1.1.0.
*/
function buildSimulatedOfficialFingerprint({
  templateKey,
  currentOfficialFingerprint,
}) {
  return sha256(
    JSON.stringify({
      simulation:
        "mi-espacio-docente-official-update",

      template_key:
        templateKey,

      simulated_version:
        SIMULATED_OFFICIAL_VERSION,

      previous_official_fingerprint:
        currentOfficialFingerprint,
    })
  );
}

/*
  Divergence locale virtuelle.

  IMPORTANT :

  On ne modifie pas le template réel.
  On construit uniquement un fingerprint
  déterministe représentant une personnalisation
  locale future.
*/
function buildSimulatedLocalFingerprint({
  templateKey,
  currentLocalFingerprint,
}) {
  return sha256(
    JSON.stringify({
      simulation:
        "mi-espacio-docente-local-change",

      template_key:
        templateKey,

      original_local_fingerprint:
        currentLocalFingerprint,

      virtual_change:
        "teacher-customization-test",
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
          test:
            "local_changes_detected",
          engine_stage:
            "1/6",
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
          test:
            "local_changes_detected",
          engine_stage:
            "1/6",
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
          test:
            "local_changes_detected",
          engine_stage:
            "1/6",
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
          test:
            "local_changes_detected",
          engine_stage:
            "1/6",
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
          test:
            "local_changes_detected",
          engine_stage:
            "1/6",
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

    const realCurrentLocalFingerprint =
      calculateFingerprint(tree);

    /*
      Précondition importante :

      Le template réel doit actuellement
      correspondre à sa baseline stockée.

      Sinon le test partirait déjà d'un état
      réellement modifié.
    */
    const realCurrentMatchesStoredLocal =
      realCurrentLocalFingerprint ===
      local.local_fingerprint;

    const simulatedOfficialFingerprint =
      buildSimulatedOfficialFingerprint({
        templateKey:
          TEST_TEMPLATE_KEY,

        currentOfficialFingerprint:
          official.official_fingerprint,
      });

    const simulatedCurrentLocalFingerprint =
      buildSimulatedLocalFingerprint({
        templateKey:
          TEST_TEMPLATE_KEY,

        currentLocalFingerprint:
          realCurrentLocalFingerprint,
      });

    const versionComparison =
      compareVersions(
        local.installed_version,
        SIMULATED_OFFICIAL_VERSION
      );

    const versionOutdated =
      versionComparison < 0;

    /*
      Comparaison à trois niveaux simulée :

      OFFICIAL
        = nouvelle référence 1.1.0

      STORED LOCAL
        = dernière baseline connue

      CURRENT LOCAL
        = état local virtuellement personnalisé
    */
    const currentMatchesStoredLocal =
      simulatedCurrentLocalFingerprint ===
      local.local_fingerprint;

    const currentMatchesOfficial =
      simulatedCurrentLocalFingerprint ===
      simulatedOfficialFingerprint;

    const officialDiffersFromStoredLocal =
      simulatedOfficialFingerprint !==
      local.local_fingerprint;

    const localDiffersFromStoredLocal =
      simulatedCurrentLocalFingerprint !==
      local.local_fingerprint;

    const localDiffersFromOfficial =
      simulatedCurrentLocalFingerprint !==
      simulatedOfficialFingerprint;

    const policyProtectsLocalChanges =
      Boolean(
        official.is_active &&
        official
          .propagate_existing_installations &&
        official.update_if_outdated &&
        official.overwrite_local_changes ===
          false &&
        official.local_changes_policy ===
          "protect"
      );

    /*
      Cas attendu :

      - nouvelle version officielle ;
      - version locale installée obsolète ;
      - le maître a changé ;
      - le local a changé ;
      - local != maître ;
      - politique protect.
    */
    const localChangesDetected =
      Boolean(
        versionOutdated &&
        officialDiffersFromStoredLocal &&
        localDiffersFromStoredLocal &&
        localDiffersFromOfficial &&
        !currentMatchesStoredLocal &&
        !currentMatchesOfficial &&
        policyProtectsLocalChanges
      );

    const status =
      localChangesDetected
        ? "local_changes_detected"
        : "test_failed";

    const recommendedAction =
      localChangesDetected
        ? {
            action:
              "protect_local_changes",

            automatic_sync_allowed:
              false,

            requires_user_action:
              true,
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
          localChangesDetected,

        message:
          localChangesDetected
            ? (
                "Test local_changes_detected réussi. " +
                "Les personnalisations locales sont " +
                "protégées contre l'écrasement automatique."
              )
            : (
                "Test local_changes_detected non validé. " +
                "Au moins une précondition de sécurité " +
                "n'est pas satisfaite."
              ),

        test:
          "local_changes_detected",

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
              realCurrentLocalFingerprint,
          },

          current_matches_stored_local:
            realCurrentMatchesStoredLocal,
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
        },

        virtual_local_change: {
          simulated: true,

          persisted: false,

          current_local_before:
            realCurrentLocalFingerprint,

          current_local_simulated:
            simulatedCurrentLocalFingerprint,

          differs_from_real_current:
            simulatedCurrentLocalFingerprint !==
            realCurrentLocalFingerprint,

          differs_from_stored_local:
            localDiffersFromStoredLocal,

          differs_from_simulated_official:
            localDiffersFromOfficial,
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

          simulated_current_local_fingerprint:
            simulatedCurrentLocalFingerprint,

          current_matches_stored_local:
            currentMatchesStoredLocal,

          current_matches_official:
            currentMatchesOfficial,

          official_differs_from_stored_local:
            officialDiffersFromStoredLocal,

          local_differs_from_stored_local:
            localDiffersFromStoredLocal,

          local_differs_from_official:
            localDiffersFromOfficial,
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

          protects_local_changes:
            policyProtectsLocalChanges,
        },

        snapshot:
          buildSnapshot(tree),

        status,

        reason:
          localChangesDetected
            ? (
                "Une nouvelle version officielle existe, " +
                "le contenu local diverge de sa baseline " +
                "et de la nouvelle référence officielle. " +
                "La politique protect interdit donc toute " +
                "synchronisation automatique destructive."
              )
            : (
                "La simulation n'a pas satisfait toutes " +
                "les conditions de local_changes_detected."
              ),

        recommended_action:
          recommendedAction,

        assertions: {
          local_template_exists:
            Boolean(realTemplate),

          local_page_readable:
            Boolean(page?.id),

          real_baseline_is_clean:
            realCurrentMatchesStoredLocal,

          installed_version_is_outdated:
            versionOutdated,

          official_update_exists:
            officialDiffersFromStoredLocal,

          simulated_local_change_exists:
            localDiffersFromStoredLocal,

          local_differs_from_new_official:
            localDiffersFromOfficial,

          policy_protects_local_changes:
            policyProtectsLocalChanges,

          final_status_is_local_changes_detected:
            status ===
            "local_changes_detected",

          automatic_sync_is_blocked:
            recommendedAction
              .automatic_sync_allowed ===
            false,

          user_action_is_required:
            recommendedAction
              .requires_user_action ===
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
      "Erreur test local_changes_detected :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        test:
          "local_changes_detected",

        engine_stage:
          "1/6",

        dry_run: true,

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
