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
  UNTRACKED_BASELINE:
    "untracked_baseline",
  INCONSISTENT_TRACKING:
    "inconsistent_tracking",
  UNREADABLE: "unreadable",
  UNKNOWN: "unknown",
};

/*
  MI ESPACIO DOCENTE
  MOTEUR DE MISE À JOUR — DRY RUN STRICT

  Ce endpoint :
  - lit la connexion OAuth du workspace ;
  - lit notion_workspace_templates ;
  - relit les templates réels dans Notion ;
  - vérifie leur existence réelle ;
  - calcule un fingerprint structurel local ;
  - compare versions et fingerprints connus ;
  - détecte les modifications locales ;
  - produit un plan de mise à jour ;
  - NE MODIFIE RIEN.

  Interdictions volontaires :
  - aucun PATCH Notion ;
  - aucun POST Notion ;
  - aucun DELETE Notion ;
  - aucun INSERT Neon ;
  - aucun UPDATE Neon ;
  - aucun DELETE Neon.

  IMPORTANT :
  official_fingerprint représente la référence
  officielle connue/enregistrée.

  local_fingerprint représente le dernier état
  local connu/enregistré.

  Le fingerprint calculé ici représente l'état
  réel du template local au moment du scan.

  Tant que official_fingerprint est NULL,
  aucune mise à jour automatique ne doit être
  autorisée : le statut devient
  untracked_baseline.
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

  const templateRows = await sql`
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

  return {
    sql,
    connection,
    templates:
      templateRows || [],
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
    "caption",
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

function determineStatus({
  row,
  realTemplate,
  currentFingerprint,
}) {
  if (!realTemplate) {
    return {
      status:
        STATUS
          .MISSING_REQUIRES_MANUAL_INSTALL,

      reason:
        "Le template enregistré dans Neon " +
        "n'existe plus dans la data source " +
        "Notion accessible.",
    };
  }

  const officialVersion =
    row.official_version || null;

  const installedVersion =
    row.installed_version || null;

  const officialFingerprint =
    row.official_fingerprint || null;

  const storedLocalFingerprint =
    row.local_fingerprint || null;

  /*
    Sans baseline officielle,
    aucune synchronisation automatique
    n'est sûre.
  */
  if (!officialFingerprint) {
    return {
      status:
        STATUS.UNTRACKED_BASELINE,

      reason:
        "Aucun official_fingerprint n'est " +
        "enregistré. Le moteur refuse de " +
        "déduire une mise à jour sûre.",
    };
  }

  const localDiffersFromOfficial =
    currentFingerprint !==
    officialFingerprint;

  const localChangedSinceStoredScan =
    Boolean(
      storedLocalFingerprint &&
      currentFingerprint !==
        storedLocalFingerprint
    );

  const versionComparison =
    compareVersions(
      installedVersion,
      officialVersion
    );

  const versionOutdated =
    versionComparison < 0;

  const versionAhead =
    versionComparison > 0;

  /*
    Cas idéal :
    version et fingerprint officiels.
  */
  if (
    !versionOutdated &&
    !versionAhead &&
    !localDiffersFromOfficial
  ) {
    return {
      status:
        STATUS.CURRENT,

      reason:
        "Version installée et fingerprint " +
        "réel correspondent à la référence " +
        "officielle connue.",
    };
  }

  /*
    Version locale en avance :
    état incohérent à ne jamais écraser.
  */
  if (versionAhead) {
    return {
      status:
        STATUS.INCONSISTENT_TRACKING,

      reason:
        "La version installée est supérieure " +
        "à la version officielle enregistrée.",
    };
  }

  /*
    Une modification depuis le dernier
    fingerprint local connu est un signal
    fort de personnalisation.
  */
  if (
    localChangedSinceStoredScan &&
    localDiffersFromOfficial
  ) {
    return {
      status:
        versionOutdated
          ? STATUS.CONFLICT
          : STATUS
              .LOCAL_CHANGES_DETECTED,

      reason:
        versionOutdated
          ? (
              "Une mise à jour officielle est " +
              "disponible et le template local " +
              "a changé depuis son dernier " +
              "fingerprint enregistré."
            )
          : (
              "Le template local a changé depuis " +
              "son dernier fingerprint enregistré."
            ),
    };
  }

  /*
    Le flag historique Neon protège aussi
    contre tout écrasement automatique.
  */
  if (
    row.locally_modified ||
    row.conflict_detected
  ) {
    return {
      status:
        versionOutdated
          ? STATUS.CONFLICT
          : STATUS
              .LOCAL_CHANGES_DETECTED,

      reason:
        "Les indicateurs Neon signalent une " +
        "modification locale ou un conflit.",
    };
  }

  /*
    Version obsolète + contenu encore égal
    à la référence officielle connue :
    candidat sûr à la mise à jour.
  */
  if (
    versionOutdated &&
    !localDiffersFromOfficial
  ) {
    return {
      status:
        STATUS.UPDATE_AVAILABLE,

      reason:
        "La version installée est obsolète " +
        "et aucune divergence locale n'est " +
        "détectée par rapport au fingerprint " +
        "officiel connu.",
    };
  }

  /*
    Même version mais divergence :
    personnalisation locale.
  */
  if (
    !versionOutdated &&
    localDiffersFromOfficial
  ) {
    return {
      status:
        STATUS
          .LOCAL_CHANGES_DETECTED,

      reason:
        "La version est actuelle mais le " +
        "contenu réel diverge du fingerprint " +
        "officiel connu.",
    };
  }

  /*
    Version obsolète + divergence non
    expliquée : protection maximale.
  */
  if (
    versionOutdated &&
    localDiffersFromOfficial
  ) {
    return {
      status:
        STATUS.CONFLICT,

      reason:
        "La version installée est obsolète " +
        "et le contenu réel diverge de la " +
        "référence officielle connue.",
    };
  }

  return {
    status:
      STATUS.UNKNOWN,

    reason:
      "L'état du template ne correspond " +
      "à aucun cas sûr connu.",
  };
}

function buildRecommendedAction(
  status
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
        automatic_sync_allowed: true,
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

    case STATUS.UNTRACKED_BASELINE:
      return {
        action:
          "initialize_fingerprint_baseline",
        automatic_sync_allowed: false,
        requires_user_action: false,
      };

    case STATUS
      .INCONSISTENT_TRACKING:
      return {
        action:
          "inspect_version_tracking",
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

async function analyzeTemplate({
  accessToken,
  row,
  templatesCache,
}) {
  const dataSourceId =
    row.notion_data_source_id;

  if (!dataSourceId) {
    return {
      template_key:
        row.template_key,

      component_key:
        row.component_key,

      name:
        row.notion_template_name,

      status:
        STATUS.UNREADABLE,

      reason:
        "Aucun notion_data_source_id " +
        "n'est enregistré.",

      recommended_action:
        buildRecommendedAction(
          STATUS.UNREADABLE
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

  /*
    Priorité absolue à l'ID.
  */
  let realTemplate =
    findTemplateById(
      realTemplates,
      row.notion_template_id
    );

  let detectionMethod =
    realTemplate
      ? "id"
      : null;

  /*
    Fallback exact par nom uniquement
    si un seul résultat existe.
  */
  if (!realTemplate) {
    const nameMatches =
      findTemplatesByExactName(
        realTemplates,
        row.notion_template_name
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
          row.template_key,

        component_key:
          row.component_key,

        name:
          row.notion_template_name,

        registered_template_id:
          row.notion_template_id,

        data_source_id:
          dataSourceId,

        status:
          STATUS.CONFLICT,

        reason:
          "L'ID enregistré n'a pas été trouvé " +
          "et plusieurs templates portent " +
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
            STATUS.CONFLICT
          ),
      };
    }
  }

  if (!realTemplate) {
    const decision =
      determineStatus({
        row,
        realTemplate: null,
        currentFingerprint: null,
      });

    return {
      template_key:
        row.template_key,

      component_key:
        row.component_key,

      name:
        row.notion_template_name,

      registered_template_id:
        row.notion_template_id,

      data_source_id:
        dataSourceId,

      status:
        decision.status,

      reason:
        decision.reason,

      recommended_action:
        buildRecommendedAction(
          decision.status
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
        row.template_key,

      component_key:
        row.component_key,

      name:
        row.notion_template_name,

      registered_template_id:
        row.notion_template_id,

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
          STATUS.UNREADABLE
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
      row,
      realTemplate,
      currentFingerprint,
    });

  const versionComparison =
    compareVersions(
      row.installed_version,
      row.official_version
    );

  return {
    template_key:
      row.template_key,

    component_key:
      row.component_key,

    name:
      row.notion_template_name,

    registered_template_id:
      row.notion_template_id,

    detected_template_id:
      realTemplateId,

    data_source_id:
      dataSourceId,

    detection_method:
      detectionMethod,

    page_readable:
      Boolean(page?.id),

    versions: {
      official:
        row.official_version,

      installed:
        row.installed_version,

      comparison:
        versionComparison,

      outdated:
        versionComparison < 0,

      ahead:
        versionComparison > 0,
    },

    fingerprints: {
      official:
        row.official_fingerprint,

      stored_local:
        row.local_fingerprint,

      current_local:
        currentFingerprint,

      current_matches_official:
        Boolean(
          row.official_fingerprint &&
          currentFingerprint ===
            row.official_fingerprint
        ),

      current_matches_stored_local:
        Boolean(
          row.local_fingerprint &&
          currentFingerprint ===
            row.local_fingerprint
        ),
    },

    neon_flags: {
      sync_status:
        row.sync_status,

      locally_modified:
        row.locally_modified,

      conflict_detected:
        row.conflict_detected,

      is_default:
        row.is_default,
    },

    snapshot,

    status:
      decision.status,

    reason:
      decision.reason,

    recommended_action:
      buildRecommendedAction(
        decision.status
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

  return {
    total_templates:
      analyses.length,

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
      templates,
    } = await getContext(req);

    const accessToken =
      connection.access_token;

    if (templates.length === 0) {
      return res
        .status(409)
        .json({
          ok: false,

          error:
            "Aucun template n'est enregistré " +
            "dans notion_workspace_templates " +
            "pour ce workspace.",

          dry_run: true,
        });
    }

    const templatesCache =
      new Map();

    const analyses = [];

    /*
      Analyse volontairement séquentielle :
      - limite la pression sur l'API Notion ;
      - facilite le diagnostic ;
      - évite un burst de requêtes récursives.
    */
    for (const row of templates) {
      try {
        const analysis =
          await analyzeTemplate({
            accessToken,
            row,
            templatesCache,
          });

        analyses.push(
          analysis
        );
      } catch (error) {
        analyses.push({
          template_key:
            row.template_key,

          component_key:
            row.component_key,

          name:
            row.notion_template_name,

          status:
            STATUS.UNREADABLE,

          reason:
            "Erreur pendant l'analyse " +
            "du template.",

          error:
            error.message,

          recommended_action:
            buildRecommendedAction(
              STATUS.UNREADABLE
            ),
        });
      }
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
          "Analyse dry-run des mises à jour " +
          "de templates terminée. " +
          "Aucune modification effectuée.",

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
        },

        summary,

        templates:
          analyses,

        next_engine_capabilities: {
          native_full_sync_proven:
            true,

          overwrite_local_changes:
            false,

          missing_template_creation:
            "unsupported_by_tested_public_api",

          safe_sync_requires:
            [
              "official_fingerprint",
              "version_outdated",
              "no_local_divergence",
            ],
        },
      });
  } catch (error) {
    console.error(
      "Erreur update dry-run :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        dry_run: true,

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
