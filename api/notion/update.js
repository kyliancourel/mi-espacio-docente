import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

const NOTION_VERSION = "2026-03-11";
const MAX_DEPTH = 20;

const STATUS = {
  CURRENT: "current",
  UPDATE_AVAILABLE: "update_available",
  LOCAL_CHANGES_DETECTED:
    "local_changes_detected",
  CONFLICT: "conflict",
  MISSING_REQUIRES_MANUAL_INSTALL:
    "missing_requires_manual_install",
  OFFICIAL_TEMPLATE_NOT_REGISTERED:
    "official_template_not_registered",
  OFFICIAL_TEMPLATE_INACTIVE:
    "official_template_inactive",
  UNTRACKED_LOCAL_BASELINE:
    "untracked_local_baseline",
  UNTRACKED_OFFICIAL_BASELINE:
    "untracked_official_baseline",
  INCONSISTENT_TRACKING:
    "inconsistent_tracking",
  UNREADABLE: "unreadable",
  UNKNOWN: "unknown",
};

/*
  MI ESPACIO DOCENTE
  MOTEUR DE MISE À JOUR V2
  DRY RUN STRICT

  ARCHITECTURE :

  notion_official_templates
    = vérité officielle centrale

  notion_workspace_templates
    = état local d'installation

  Notion réel
    = état réel actuel du template

  Ce endpoint :
  - lit la connexion OAuth du workspace ;
  - lit le registre officiel central ;
  - lit l'état local du workspace ;
  - relit les templates réels dans Notion ;
  - calcule leur fingerprint réel ;
  - compare :
      1. référence officielle centrale,
      2. dernier état local connu,
      3. état local réel actuel ;
  - détecte :
      current,
      update_available,
      local_changes_detected,
      conflict,
      missing_requires_manual_install ;
  - NE MODIFIE RIEN.

  INTERDICTIONS :
  - aucun PATCH Notion ;
  - aucun POST Notion ;
  - aucun DELETE Notion ;
  - aucun INSERT Neon ;
  - aucun UPDATE Neon ;
  - aucun DELETE Neon.

  RÈGLE DE SÉCURITÉ CENTRALE :

  Une mise à jour automatique n'est candidate
  que si :
  - une nouvelle version officielle existe ;
  - update_if_outdated = true ;
  - propagate_existing_installations = true ;
  - overwrite_local_changes n'est pas requis ;
  - le template réel correspond encore au
    dernier fingerprint local connu.

  Ainsi :
  - ancien template intact => update_available
  - ancien template personnalisé => conflict
  - template actuel personnalisé =>
    local_changes_detected
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

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00A0/g, " ")
    .replace(
      /[\u200B-\u200D\uFEFF]/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
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

    error.notionStatus =
      response.status;

    error.notionData =
      data;

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

  /*
    État local du workspace.
    Les anciennes colonnes official_*
    sont encore lues uniquement à des fins
    de diagnostic/migration.

    Elles ne sont PLUS la vérité officielle.
  */
  const workspaceTemplateRows =
    await sql`
      SELECT
        id,
        workspace_id,
        template_key,
        component_key,
        notion_template_id,
        notion_data_source_id,
        notion_template_name,
        official_version,
        installed_version,
        official_fingerprint,
        local_fingerprint,
        sync_status,
        is_default,
        locally_modified,
        conflict_detected,
        last_detected_at,
        last_synced_at,
        created_at,
        updated_at
      FROM notion_workspace_templates
      WHERE workspace_id = ${workspaceId}
      ORDER BY
        component_key ASC,
        template_key ASC
    `;

  /*
    Vérité officielle centrale.
  */
  const officialTemplateRows =
    await sql`
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
        is_default,
        is_active,
        propagate_new_installations,
        propagate_existing_installations,
        create_if_missing,
        update_if_outdated,
        overwrite_local_changes,
        local_changes_policy,
        created_at,
        updated_at
      FROM notion_official_templates
      ORDER BY
        component_key ASC,
        template_key ASC
    `;

  return {
    connection,

    workspaceTemplates:
      workspaceTemplateRows || [],

    officialTemplates:
      officialTemplateRows || [],
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

function calculateFingerprint(
  tree
) {
  const canonical =
    canonicalize(tree);

  return sha256(
    JSON.stringify(canonical)
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
  const blockTypes =
    Object.fromEntries(
      Object.entries(
        countBlockTypes(tree, {})
      ).sort(
        ([left], [right]) =>
          left.localeCompare(right)
      )
    );

  return {
    recursive_block_count:
      countBlocks(tree),

    block_types:
      blockTypes,
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

function findTemplatesByExactName(
  templates,
  expectedName
) {
  const normalizedExpected =
    normalizeText(expectedName);

  return templates.filter(
    (template) =>
      normalizeText(
        template?.name
      ) === normalizedExpected
  );
}

function buildOfficialMap(
  officialTemplates
) {
  return new Map(
    officialTemplates.map(
      (template) => [
        template.template_key,
        template,
      ]
    )
  );
}

function buildWorkspaceMap(
  workspaceTemplates
) {
  return new Map(
    workspaceTemplates.map(
      (template) => [
        template.template_key,
        template,
      ]
    )
  );
}

function determineStatus({
  local,
  official,
  realTemplate,
  currentFingerprint,
}) {
  if (!official) {
    return {
      status:
        STATUS
          .OFFICIAL_TEMPLATE_NOT_REGISTERED,

      reason:
        "Aucune référence centrale n'existe " +
        "dans notion_official_templates.",
    };
  }

  if (!official.is_active) {
    return {
      status:
        STATUS.OFFICIAL_TEMPLATE_INACTIVE,

      reason:
        "Le template officiel central est " +
        "désactivé.",
    };
  }

  if (!official.official_fingerprint) {
    return {
      status:
        STATUS
          .UNTRACKED_OFFICIAL_BASELINE,

      reason:
        "Le registre central ne contient " +
        "aucun official_fingerprint.",
    };
  }

  if (!local) {
    return {
      status:
        STATUS
          .MISSING_REQUIRES_MANUAL_INSTALL,

      reason:
        official.create_if_missing
          ? (
              "Le template officiel doit être " +
              "présent dans ce workspace, mais " +
              "aucune installation locale n'est " +
              "enregistrée. La création native " +
              "d'un nouvel objet template n'est " +
              "pas prouvée par l'API testée."
            )
          : (
              "Aucune installation locale n'est " +
              "enregistrée et la politique " +
              "create_if_missing est désactivée."
            ),
    };
  }

  if (!realTemplate) {
    return {
      status:
        STATUS
          .MISSING_REQUIRES_MANUAL_INSTALL,

      reason:
        "L'installation locale est enregistrée " +
        "dans Neon mais le template réel n'est " +
        "plus détecté dans Notion.",
    };
  }

  const officialVersion =
    official.official_version || null;

  const installedVersion =
    local.installed_version || null;

  const officialFingerprint =
    official.official_fingerprint || null;

  const storedLocalFingerprint =
    local.local_fingerprint || null;

  if (!storedLocalFingerprint) {
    return {
      status:
        STATUS
          .UNTRACKED_LOCAL_BASELINE,

      reason:
        "Aucun local_fingerprint n'est " +
        "enregistré pour cette installation.",
    };
  }

  const versionComparison =
    compareVersions(
      installedVersion,
      officialVersion
    );

  const versionOutdated =
    versionComparison < 0;

  const versionAhead =
    versionComparison > 0;

  const currentMatchesOfficial =
    currentFingerprint ===
    officialFingerprint;

  const currentMatchesStoredLocal =
    currentFingerprint ===
    storedLocalFingerprint;

  const storedLocalMatchesOfficial =
    storedLocalFingerprint ===
    officialFingerprint;

  /*
    Version locale supérieure à l'officielle :
    incohérence de suivi.
  */
  if (versionAhead) {
    return {
      status:
        STATUS.INCONSISTENT_TRACKING,

      reason:
        "La version installée est supérieure " +
        "à la version officielle centrale.",
    };
  }

  /*
    Version identique + contenu officiel exact.
  */
  if (
    !versionOutdated &&
    currentMatchesOfficial
  ) {
    return {
      status:
        STATUS.CURRENT,

      reason:
        "Version installée et fingerprint réel " +
        "correspondent à la référence officielle " +
        "centrale.",
    };
  }

  /*
    Version obsolète, mais le contenu réel
    correspond déjà au nouveau maître.

    Cela peut arriver après une synchronisation
    Notion réussie avant mise à jour du tracking.
  */
  if (
    versionOutdated &&
    currentMatchesOfficial
  ) {
    return {
      status:
        STATUS.INCONSISTENT_TRACKING,

      reason:
        "Le contenu réel correspond déjà au " +
        "nouveau fingerprint officiel, mais " +
        "installed_version est encore obsolète.",
    };
  }

  /*
    Le contenu réel a changé depuis le dernier
    état local connu.

    C'est le signal principal de modification
    locale.
  */
  if (!currentMatchesStoredLocal) {
    return {
      status:
        versionOutdated
          ? STATUS.CONFLICT
          : STATUS
              .LOCAL_CHANGES_DETECTED,

      reason:
        versionOutdated
          ? (
              "Une mise à jour officielle existe " +
              "et le template réel a changé depuis " +
              "le dernier fingerprint local connu."
            )
          : (
              "Le template réel a changé depuis " +
              "le dernier fingerprint local connu."
            ),
    };
  }

  /*
    Les flags historiques restent protecteurs.
  */
  if (
    local.locally_modified ||
    local.conflict_detected
  ) {
    return {
      status:
        versionOutdated
          ? STATUS.CONFLICT
          : STATUS
              .LOCAL_CHANGES_DETECTED,

      reason:
        "Les indicateurs locaux Neon signalent " +
        "une modification locale ou un conflit.",
    };
  }

  /*
    Cas central de mise à jour sûre :

    - version locale obsolète ;
    - état réel inchangé depuis la dernière
      baseline locale ;
    - propagation autorisée ;
    - mise à jour autorisée.

    Le fait que stored_local diffère du nouveau
    fingerprint officiel est NORMAL :
    il représente l'ancienne version installée.
  */
  if (
    versionOutdated &&
    currentMatchesStoredLocal
  ) {
    if (
      !official
        .propagate_existing_installations
    ) {
      return {
        status:
          STATUS.INCONSISTENT_TRACKING,

        reason:
          "Une nouvelle version officielle existe " +
          "mais la propagation aux installations " +
          "existantes est désactivée.",
      };
    }

    if (!official.update_if_outdated) {
      return {
        status:
          STATUS.INCONSISTENT_TRACKING,

        reason:
          "Une nouvelle version officielle existe " +
          "mais update_if_outdated est désactivé.",
      };
    }

    return {
      status:
        STATUS.UPDATE_AVAILABLE,

      reason:
        storedLocalMatchesOfficial
          ? (
              "La version installée est obsolète, " +
              "le template réel est inchangé et " +
              "reste sur une baseline compatible."
            )
          : (
              "La version installée est obsolète " +
              "et le template réel correspond " +
              "exactement au dernier fingerprint " +
              "local connu. Aucune modification " +
              "locale récente n'est détectée."
            ),
    };
  }

  /*
    Même version, contenu réel inchangé depuis
    le dernier scan, mais différent du maître :
    personnalisation locale persistante.
  */
  if (
    !versionOutdated &&
    currentMatchesStoredLocal &&
    !currentMatchesOfficial
  ) {
    return {
      status:
        STATUS
          .LOCAL_CHANGES_DETECTED,

      reason:
        "La version installée est actuelle, mais " +
        "la baseline locale diffère de la référence " +
        "officielle centrale.",
    };
  }

  return {
    status:
      STATUS.UNKNOWN,

    reason:
      "L'état du template ne correspond à " +
      "aucun cas sûr connu.",
  };
}

function buildRecommendedAction(
  status,
  official = null
) {
  switch (status) {
    case STATUS.CURRENT:
      return {
        action: "none",
        automatic_sync_allowed: false,
        requires_user_action: false,
      };

    case STATUS.UPDATE_AVAILABLE:
      return {
        action:
          "native_sync_candidate",

        automatic_sync_allowed:
          Boolean(
            official &&
            official.is_active &&
            official
              .propagate_existing_installations &&
            official.update_if_outdated
          ),

        requires_user_action: false,
      };

    case STATUS
      .LOCAL_CHANGES_DETECTED:
      return {
        action:
          "protect_local_changes",
        automatic_sync_allowed: false,
        requires_user_action: true,
      };

    case STATUS.CONFLICT:
      return {
        action:
          "manual_conflict_resolution",
        automatic_sync_allowed: false,
        requires_user_action: true,
      };

    case STATUS
      .MISSING_REQUIRES_MANUAL_INSTALL:
      return {
        action:
          "manual_template_install",
        automatic_sync_allowed: false,
        requires_user_action: true,
      };

    case STATUS
      .OFFICIAL_TEMPLATE_NOT_REGISTERED:
      return {
        action:
          "register_official_template",
        automatic_sync_allowed: false,
        requires_user_action: true,
      };

    case STATUS
      .OFFICIAL_TEMPLATE_INACTIVE:
      return {
        action:
          "none_official_inactive",
        automatic_sync_allowed: false,
        requires_user_action: false,
      };

    case STATUS
      .UNTRACKED_LOCAL_BASELINE:
      return {
        action:
          "initialize_local_fingerprint_baseline",
        automatic_sync_allowed: false,
        requires_user_action: false,
      };

    case STATUS
      .UNTRACKED_OFFICIAL_BASELINE:
      return {
        action:
          "initialize_official_fingerprint_baseline",
        automatic_sync_allowed: false,
        requires_user_action: true,
      };

    case STATUS
      .INCONSISTENT_TRACKING:
      return {
        action:
          "inspect_tracking_state",
        automatic_sync_allowed: false,
        requires_user_action: true,
      };

    case STATUS.UNREADABLE:
      return {
        action:
          "inspect_notion_access",
        automatic_sync_allowed: false,
        requires_user_action: true,
      };

    default:
      return {
        action:
          "manual_review",
        automatic_sync_allowed: false,
        requires_user_action: true,
      };
  }
}

async function analyzeInstalledTemplate({
  accessToken,
  local,
  official,
  templatesCache,
}) {
  const dataSourceId =
    local.notion_data_source_id;

  if (!dataSourceId) {
    return {
      template_key:
        local.template_key,

      component_key:
        local.component_key,

      name:
        local.notion_template_name,

      official_reference:
        official
          ? {
              version:
                official.official_version,

              fingerprint:
                official.official_fingerprint,
            }
          : null,

      status:
        STATUS.UNREADABLE,

      reason:
        "Aucun notion_data_source_id local " +
        "n'est enregistré.",

      recommended_action:
        buildRecommendedAction(
          STATUS.UNREADABLE,
          official
        ),
    };
  }

  let realTemplates =
    templatesCache.get(
      dataSourceId
    );

  if (!realTemplates) {
    realTemplates =
      await listAllTemplates(
        accessToken,
        dataSourceId
      );

    templatesCache.set(
      dataSourceId,
      realTemplates
    );
  }

  let realTemplate =
    findTemplateById(
      realTemplates,
      local.notion_template_id
    );

  let detectionMethod =
    realTemplate
      ? "id"
      : null;

  if (!realTemplate) {
    const nameMatches =
      findTemplatesByExactName(
        realTemplates,
        local.notion_template_name
      );

    if (nameMatches.length === 1) {
      realTemplate =
        nameMatches[0];

      detectionMethod =
        "exact_name_fallback";
    }

    if (nameMatches.length > 1) {
      return {
        template_key:
          local.template_key,

        component_key:
          local.component_key,

        name:
          local.notion_template_name,

        registered_template_id:
          local.notion_template_id,

        data_source_id:
          dataSourceId,

        status:
          STATUS.CONFLICT,

        reason:
          "L'ID local enregistré n'a pas été " +
          "trouvé et plusieurs templates portent " +
          "exactement le même nom.",

        duplicate_candidates:
          nameMatches.map(
            (template) => ({
              id:
                template.id,

              name:
                template.name,
            })
          ),

        recommended_action:
          buildRecommendedAction(
            STATUS.CONFLICT,
            official
          ),
      };
    }
  }

  if (!realTemplate) {
    const decision =
      determineStatus({
        local,
        official,
        realTemplate: null,
        currentFingerprint: null,
      });

    return {
      template_key:
        local.template_key,

      component_key:
        local.component_key,

      name:
        local.notion_template_name,

      registered_template_id:
        local.notion_template_id,

      data_source_id:
        dataSourceId,

      official_reference:
        official
          ? {
              version:
                official.official_version,

              fingerprint:
                official.official_fingerprint,
            }
          : null,

      status:
        decision.status,

      reason:
        decision.reason,

      recommended_action:
        buildRecommendedAction(
          decision.status,
          official
        ),
    };
  }

  const realTemplateId =
    realTemplate.id;

  let page;

  try {
    page = await notion(
      accessToken,
      `/pages/${realTemplateId}`,
      {
        method: "GET",
      }
    );
  } catch (error) {
    return {
      template_key:
        local.template_key,

      component_key:
        local.component_key,

      name:
        local.notion_template_name,

      registered_template_id:
        local.notion_template_id,

      detected_template_id:
        realTemplateId,

      data_source_id:
        dataSourceId,

      detection_method:
        detectionMethod,

      status:
        STATUS.UNREADABLE,

      reason:
        "Le template existe dans la liste " +
        "mais n'est pas lisible comme page.",

      notion_error:
        error.message,

      recommended_action:
        buildRecommendedAction(
          STATUS.UNREADABLE,
          official
        ),
    };
  }

  const tree =
    await readBlockTree(
      accessToken,
      realTemplateId
    );

  const currentFingerprint =
    calculateFingerprint(tree);

  const snapshot =
    buildSnapshot(tree);

  const decision =
    determineStatus({
      local,
      official,
      realTemplate,
      currentFingerprint,
    });

  const versionComparison =
    official
      ? compareVersions(
          local.installed_version,
          official.official_version
        )
      : null;

  return {
    template_key:
      local.template_key,

    component_key:
      local.component_key,

    name:
      local.notion_template_name,

    registered_template_id:
      local.notion_template_id,

    detected_template_id:
      realTemplateId,

    data_source_id:
      dataSourceId,

    detection_method:
      detectionMethod,

    page_readable:
      Boolean(page?.id),

    official_reference:
      official
        ? {
            template_key:
              official.template_key,

            component_key:
              official.component_key,

            name:
              official.notion_template_name,

            version:
              official.official_version,

            fingerprint:
              official.official_fingerprint,

            master_workspace_id:
              official.master_workspace_id,

            master_template_id:
              official
                .master_notion_template_id,

            master_data_source_id:
              official
                .master_notion_data_source_id,

            is_active:
              official.is_active,
          }
        : null,

    versions: {
      official:
        official
          ?.official_version ||
        null,

      installed:
        local.installed_version,

      comparison:
        versionComparison,

      outdated:
        versionComparison !== null
          ? versionComparison < 0
          : null,

      ahead:
        versionComparison !== null
          ? versionComparison > 0
          : null,
    },

    fingerprints: {
      official:
        official
          ?.official_fingerprint ||
        null,

      stored_local:
        local.local_fingerprint,

      current_local:
        currentFingerprint,

      legacy_workspace_official:
        local.official_fingerprint,

      current_matches_official:
        Boolean(
          official
            ?.official_fingerprint &&
          currentFingerprint ===
            official.official_fingerprint
        ),

      current_matches_stored_local:
        Boolean(
          local.local_fingerprint &&
          currentFingerprint ===
            local.local_fingerprint
        ),

      stored_local_matches_official:
        Boolean(
          local.local_fingerprint &&
          official
            ?.official_fingerprint &&
          local.local_fingerprint ===
            official.official_fingerprint
        ),
    },

    local_tracking: {
      sync_status:
        local.sync_status,

      locally_modified:
        local.locally_modified,

      conflict_detected:
        local.conflict_detected,

      is_default:
        local.is_default,

      last_detected_at:
        local.last_detected_at,

      last_synced_at:
        local.last_synced_at,
    },

    propagation_policy:
      official
        ? {
            new_installations:
              official
                .propagate_new_installations,

            existing_installations:
              official
                .propagate_existing_installations,

            create_if_missing:
              official.create_if_missing,

            update_if_outdated:
              official.update_if_outdated,

            overwrite_local_changes:
              official
                .overwrite_local_changes,

            local_changes_policy:
              official.local_changes_policy,
          }
        : null,

    snapshot,

    status:
      decision.status,

    reason:
      decision.reason,

    recommended_action:
      buildRecommendedAction(
        decision.status,
        official
      ),
  };
}

function analyzeMissingLocalInstallation(
  official
) {
  const decision =
    determineStatus({
      local: null,
      official,
      realTemplate: null,
      currentFingerprint: null,
    });

  return {
    template_key:
      official.template_key,

    component_key:
      official.component_key,

    name:
      official.notion_template_name,

    local_installation_registered:
      false,

    official_reference: {
      version:
        official.official_version,

      fingerprint:
        official.official_fingerprint,

      master_workspace_id:
        official.master_workspace_id,

      master_template_id:
        official.master_notion_template_id,

      master_data_source_id:
        official
          .master_notion_data_source_id,

      is_active:
        official.is_active,
    },

    propagation_policy: {
      new_installations:
        official
          .propagate_new_installations,

      existing_installations:
        official
          .propagate_existing_installations,

      create_if_missing:
        official.create_if_missing,

      update_if_outdated:
        official.update_if_outdated,

      overwrite_local_changes:
        official.overwrite_local_changes,

      local_changes_policy:
        official.local_changes_policy,
    },

    status:
      decision.status,

    reason:
      decision.reason,

    recommended_action:
      buildRecommendedAction(
        decision.status,
        official
      ),
  };
}

function buildSummary(
  analyses
) {
  const byStatus = {};

  for (const analysis of analyses) {
    const status =
      analysis.status ||
      STATUS.UNKNOWN;

    byStatus[status] =
      (
        byStatus[status] || 0
      ) + 1;
  }

  const automaticSyncCandidates =
    analyses.filter(
      (analysis) =>
        analysis
          ?.recommended_action
          ?.automatic_sync_allowed ===
        true
    ).length;

  const protectedTemplates =
    analyses.filter(
      (analysis) =>
        [
          STATUS
            .LOCAL_CHANGES_DETECTED,
          STATUS.CONFLICT,
        ].includes(
          analysis.status
        )
    ).length;

  const manualActionsRequired =
    analyses.filter(
      (analysis) =>
        analysis
          ?.recommended_action
          ?.requires_user_action ===
        true
    ).length;

  const currentTemplates =
    analyses.filter(
      (analysis) =>
        analysis.status ===
        STATUS.CURRENT
    ).length;

  return {
    total_templates:
      analyses.length,

    current_templates:
      currentTemplates,

    by_status:
      byStatus,

    automatic_sync_candidates:
      automaticSyncCandidates,

    protected_templates:
      protectedTemplates,

    manual_actions_required:
      manualActionsRequired,
  };
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
      workspaceTemplates,
      officialTemplates,
    } = await getContext(req);

    const accessToken =
      connection.access_token;

    if (officialTemplates.length === 0) {
      return res
        .status(409)
        .json({
          ok: false,

          dry_run: true,

          error:
            "Le registre central " +
            "notion_official_templates " +
            "est vide.",
        });
    }

    const officialMap =
      buildOfficialMap(
        officialTemplates
      );

    const workspaceMap =
      buildWorkspaceMap(
        workspaceTemplates
      );

    const templatesCache =
      new Map();

    const analyses = [];

    /*
      1. Analyse de toutes les références
         officielles centrales.

      Cela permet aussi de détecter un template
      officiel absent du workspace local.
    */
    for (
      const official
      of officialTemplates
    ) {
      const local =
        workspaceMap.get(
          official.template_key
        );

      if (!local) {
        analyses.push(
          analyzeMissingLocalInstallation(
            official
          )
        );

        continue;
      }

      try {
        const analysis =
          await analyzeInstalledTemplate({
            accessToken,
            local,
            official,
            templatesCache,
          });

        analyses.push(
          analysis
        );
      } catch (error) {
        analyses.push({
          template_key:
            official.template_key,

          component_key:
            official.component_key,

          name:
            official.notion_template_name,

          status:
            STATUS.UNREADABLE,

          reason:
            "Erreur pendant l'analyse " +
            "du template.",

          error:
            error.message,

          recommended_action:
            buildRecommendedAction(
              STATUS.UNREADABLE,
              official
            ),
        });
      }
    }

    /*
      2. Détection des installations locales
         qui n'existent plus dans le registre
         officiel central.

      Elles ne doivent jamais être supprimées
      automatiquement.
    */
    for (
      const local
      of workspaceTemplates
    ) {
      if (
        officialMap.has(
          local.template_key
        )
      ) {
        continue;
      }

      analyses.push({
        template_key:
          local.template_key,

        component_key:
          local.component_key,

        name:
          local.notion_template_name,

        registered_template_id:
          local.notion_template_id,

        data_source_id:
          local.notion_data_source_id,

        status:
          STATUS
            .OFFICIAL_TEMPLATE_NOT_REGISTERED,

        reason:
          "Cette installation locale existe " +
          "mais aucune référence officielle " +
          "centrale ne correspond à son " +
          "template_key.",

        recommended_action:
          buildRecommendedAction(
            STATUS
              .OFFICIAL_TEMPLATE_NOT_REGISTERED,
            null
          ),
      });
    }

    const summary =
      buildSummary(
        analyses
      );

    return res
      .status(200)
      .json({
        ok: true,

        message:
          "Analyse V2 dry-run des mises à jour " +
          "de templates terminée. " +
          "Aucune modification effectuée.",

        engine_version:
          "2.0.0",

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

        registry: {
          source:
            "notion_official_templates",

          official_template_count:
            officialTemplates.length,

          active_official_template_count:
            officialTemplates.filter(
              (template) =>
                template.is_active
            ).length,

          local_installation_count:
            workspaceTemplates.length,

          central_truth_enabled:
            true,

          legacy_workspace_official_fields:
            "diagnostic_only",
        },

        safety: {
          notion_write_operations:
            0,

          neon_write_operations:
            0,

          templates_modified:
            0,

          pages_modified:
            0,

          automatic_sync_executed:
            false,

          overwrite_local_changes:
            false,
        },

        summary,

        templates:
          analyses,

        engine_capabilities: {
          central_official_registry:
            true,

          three_way_comparison:
            true,

          compares:
            [
              "official_central_fingerprint",
              "stored_local_fingerprint",
              "current_real_local_fingerprint",
            ],

          native_full_sync_proven:
            true,

          native_full_sync_enabled:
            false,

          missing_template_creation:
            "unsupported_by_tested_public_api",

          local_change_protection:
            true,

          safe_sync_candidate_requires:
            [
              "official_template_active",
              "version_outdated",
              "current_matches_stored_local",
              "propagate_existing_installations",
              "update_if_outdated",
            ],
        },
      });
  } catch (error) {
    console.error(
      "Erreur update V2 dry-run :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        engine_version:
          "2.0.0",

        dry_run: true,

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
