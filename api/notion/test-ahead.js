import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2026-03-11";
const TEST_TEMPLATE_KEY = "student_sheet";

/*
  MI ESPACIO DOCENTE
  TEST AHEAD
  ÉTAPE 1/6
  DRY RUN STRICT

  OBJECTIF :

  Vérifier qu'une installation locale dont la version
  installée est supérieure à la version officielle
  n'est jamais rétrogradée automatiquement.

  Exemple simulé :

    officielle : 1.0.0
    installée  : 1.1.0

  Résultat attendu :

    status = ahead

    action =
      preserve_ahead_installation

    automatic_sync_allowed = false

    requires_user_action = true

  IMPORTANT :

  Le test est purement virtuel.

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

function parseVersion(version) {
  const raw =
    String(version || "").trim();

  const match = raw.match(
    /^(\d+)\.(\d+)\.(\d+)$/
  );

  if (!match) {
    throw new Error(
      `Version invalide : ${raw}`
    );
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(
  installedVersion,
  officialVersion
) {
  const installed =
    parseVersion(installedVersion);

  const official =
    parseVersion(officialVersion);

  const installedParts = [
    installed.major,
    installed.minor,
    installed.patch,
  ];

  const officialParts = [
    official.major,
    official.minor,
    official.patch,
  ];

  for (
    let index = 0;
    index < 3;
    index += 1
  ) {
    if (
      installedParts[index] <
      officialParts[index]
    ) {
      return -1;
    }

    if (
      installedParts[index] >
      officialParts[index]
    ) {
      return 1;
    }
  }

  return 0;
}

function createAheadVersion(
  officialVersion
) {
  const parsed =
    parseVersion(officialVersion);

  return [
    parsed.major,
    parsed.minor + 1,
    0,
  ].join(".");
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
      create_if_missing,
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
            "ahead",

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
            "ahead",

          engine_stage:
            "1/6",

          dry_run: true,

          error:
            "Référence officielle student_sheet introuvable.",
        });
    }

    if (
      !official.official_version
    ) {
      return res
        .status(409)
        .json({
          ok: false,

          test:
            "ahead",

          engine_stage:
            "1/6",

          dry_run: true,

          error:
            "Version officielle absente.",
        });
    }

    if (
      !local.installed_version
    ) {
      return res
        .status(409)
        .json({
          ok: false,

          test:
            "ahead",

          engine_stage:
            "1/6",

          dry_run: true,

          error:
            "Version installée réelle absente.",
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
            "ahead",

          engine_stage:
            "1/6",

          dry_run: true,

          error:
            "Fingerprint officiel absent.",
        });
    }

    if (
      !local.local_fingerprint
    ) {
      return res
        .status(409)
        .json({
          ok: false,

          test:
            "ahead",

          engine_stage:
            "1/6",

          dry_run: true,

          error:
            "Baseline locale absente.",
        });
    }

    const accessToken =
      connection.access_token;

    /*
      Vérification réelle du template.
      Lecture uniquement.
    */
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
            "ahead",

          engine_stage:
            "1/6",

          dry_run: true,

          error:
            "Le vrai template local est absent.",
        });
    }

    const realPage =
      await notion(
        accessToken,
        `/pages/${realTemplate.id}`,
        {
          method: "GET",
        }
      );

    const realPageReadable =
      Boolean(realPage?.id);

    if (!realPageReadable) {
      return res
        .status(409)
        .json({
          ok: false,

          test:
            "ahead",

          engine_stage:
            "1/6",

          dry_run: true,

          error:
            "Le vrai template local n'est pas lisible.",
        });
    }

    /*
      Simulation contrôlée :

      officielle = vraie version officielle
      installée  = version virtuelle supérieure

      Rien n'est persisté.
    */
    const simulatedInstalledVersion =
      createAheadVersion(
        official.official_version
      );

    const comparison =
      compareVersions(
        simulatedInstalledVersion,
        official.official_version
      );

    const ahead =
      comparison > 0;

    const outdated =
      comparison < 0;

    const equal =
      comparison === 0;

    /*
      Règle de sécurité :

      Une installation en avance ne doit
      jamais être remplacée automatiquement
      par une version officielle inférieure.
    */
    const automaticSyncAllowed =
      false;

    const downgradeAttempted =
      false;

    const status =
      ahead
        ? "ahead"
        : "test_failed";

    const recommendedAction =
      ahead
        ? {
            action:
              "preserve_ahead_installation",

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

    const assertions = {
      local_template_exists:
        Boolean(realTemplate),

      local_page_readable:
        realPageReadable,

      official_version_exists:
        Boolean(
          official.official_version
        ),

      real_installed_version_exists:
        Boolean(
          local.installed_version
        ),

      simulated_installed_version_is_higher:
        comparison > 0,

      comparison_is_positive:
        comparison === 1,

      ahead_is_detected:
        ahead === true,

      outdated_is_false:
        outdated === false,

      equal_is_false:
        equal === false,

      final_status_is_ahead:
        status === "ahead",

      preserve_ahead_installation_is_recommended:
        recommendedAction.action ===
        "preserve_ahead_installation",

      automatic_sync_is_blocked:
        automaticSyncAllowed ===
        false,

      downgrade_is_not_attempted:
        downgradeAttempted ===
        false,

      user_action_is_required:
        recommendedAction
          .requires_user_action ===
        true,
    };

    const allAssertionsPassed =
      Object.values(
        assertions
      ).every(
        (value) => value === true
      );

    return res
      .status(200)
      .json({
        ok:
          allAssertionsPassed,

        message:
          allAssertionsPassed
            ? (
                "Test ahead réussi. " +
                "Une installation locale en avance " +
                "sur la version officielle est préservée " +
                "et ne peut pas être rétrogradée automatiquement."
              )
            : (
                "Test ahead non validé. " +
                "Au moins une assertion a échoué."
              ),

        test:
          "ahead",

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
            realPageReadable,
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

            local_baseline:
              local.local_fingerprint,
          },

          template_exists:
            Boolean(realTemplate),

          page_readable:
            realPageReadable,
        },

        virtual_ahead_state: {
          simulated: true,
          persisted: false,

          official_version:
            official.official_version,

          installed_version_before:
            local.installed_version,

          installed_version_simulated:
            simulatedInstalledVersion,

          simulated_version_differs_from_real:
            simulatedInstalledVersion !==
            local.installed_version,

          simulated_version_is_higher_than_official:
            comparison > 0,
        },

        versions: {
          official:
            official.official_version,

          installed:
            simulatedInstalledVersion,

          comparison,

          outdated,

          equal,

          ahead,
        },

        decision: {
          ahead_detected:
            ahead,

          automatic_sync_allowed:
            automaticSyncAllowed,

          downgrade_attempted:
            downgradeAttempted,

          preserve_local_installation:
            ahead,
        },

        status,

        reason:
          ahead
            ? (
                "La version installée simulée est supérieure " +
                "à la version officielle. Une synchronisation " +
                "automatique appliquerait potentiellement une " +
                "rétrogradation. Le moteur préserve donc " +
                "l'installation locale et exige une décision explicite."
              )
            : (
                "La simulation n'a pas produit une version " +
                "installée supérieure à la version officielle."
              ),

        recommended_action:
          recommendedAction,

        assertions,

        safety: {
          notion_write_operations: 0,
          neon_write_operations: 0,
          templates_modified: 0,
          templates_deleted: 0,
          pages_modified: 0,
          pages_deleted: 0,
          official_registry_modified: false,
          local_tracking_modified: false,
          installed_version_modified: false,
          downgrade_attempted:
            downgradeAttempted,
          automatic_sync_executed: false,
        },
      });
  } catch (error) {
    console.error(
      "Erreur test ahead :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        test:
          "ahead",

        engine_stage:
          "1/6",

        dry_run: true,

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
