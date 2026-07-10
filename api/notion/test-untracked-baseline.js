import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2026-03-11";
const TEST_TEMPLATE_KEY = "student_sheet";

/*
  MI ESPACIO DOCENTE
  TEST UNTRACKED BASELINE
  ÉTAPE 1/6
  DRY RUN STRICT

  OBJECTIF :

  Vérifier que le moteur refuse toute synchronisation
  automatique lorsqu'il manque une référence nécessaire
  à la comparaison sûre.

  Deux sous-scénarios sont simulés :

  A. official_fingerprint manquant
  B. local_fingerprint / baseline locale manquant

  Le vrai template :
  - existe ;
  - est détecté ;
  - est lisible ;
  - n'est jamais modifié.

  Résultat attendu :

  status = untracked_baseline

  action =
    initialize_fingerprint_baseline

  automatic_sync_allowed = false

  requires_user_action = false

  IMPORTANT :

  Ici requires_user_action = false car l'initialisation
  de baseline pourra être une opération contrôlée du moteur,
  distincte d'une synchronisation destructive.

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

function evaluateScenario({
  scenarioKey,
  officialFingerprint,
  localFingerprint,
}) {
  const officialFingerprintKnown =
    Boolean(officialFingerprint);

  const localBaselineKnown =
    Boolean(localFingerprint);

  const safeComparisonPossible =
    Boolean(
      officialFingerprintKnown &&
      localBaselineKnown
    );

  const untrackedBaseline =
    !safeComparisonPossible;

  const automaticSyncAllowed =
    false;

  const status =
    untrackedBaseline
      ? "untracked_baseline"
      : "test_failed";

  const recommendedAction =
    untrackedBaseline
      ? {
          action:
            "initialize_fingerprint_baseline",

          automatic_sync_allowed:
            false,

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

  return {
    scenario_key:
      scenarioKey,

    inputs: {
      official_fingerprint:
        officialFingerprint,

      local_fingerprint:
        localFingerprint,
    },

    tracking_state: {
      official_fingerprint_known:
        officialFingerprintKnown,

      local_baseline_known:
        localBaselineKnown,

      safe_comparison_possible:
        safeComparisonPossible,

      untracked_baseline:
        untrackedBaseline,
    },

    status,

    recommended_action:
      recommendedAction,

    assertions: {
      safe_comparison_is_impossible:
        safeComparisonPossible ===
        false,

      untracked_baseline_is_detected:
        untrackedBaseline === true,

      automatic_sync_is_blocked:
        automaticSyncAllowed ===
        false,

      final_status_is_untracked_baseline:
        status ===
        "untracked_baseline",

      baseline_initialization_is_recommended:
        recommendedAction.action ===
        "initialize_fingerprint_baseline",

      destructive_sync_is_not_recommended:
        recommendedAction
          .automatic_sync_allowed ===
        false,
    },
  };
}

function allAssertionsTrue(
  assertions = {}
) {
  return Object.values(
    assertions
  ).every(
    (value) => value === true
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
            "untracked_baseline",

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
            "untracked_baseline",

          engine_stage:
            "1/6",

          dry_run: true,

          error:
            "Référence officielle student_sheet introuvable.",
        });
    }

    /*
      Précondition réelle :

      Pour prouver une simulation propre,
      les deux fingerprints réels doivent
      actuellement exister.
    */
    if (
      !official.official_fingerprint
    ) {
      return res
        .status(409)
        .json({
          ok: false,

          test:
            "untracked_baseline",

          engine_stage:
            "1/6",

          dry_run: true,

          error:
            "Le fingerprint officiel réel est déjà absent. " +
            "Simulation contrôlée refusée.",
        });
    }

    if (!local.local_fingerprint) {
      return res
        .status(409)
        .json({
          ok: false,

          test:
            "untracked_baseline",

          engine_stage:
            "1/6",

          dry_run: true,

          error:
            "La baseline locale réelle est déjà absente. " +
            "Simulation contrôlée refusée.",
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
            "untracked_baseline",

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
            "untracked_baseline",

          engine_stage:
            "1/6",

          dry_run: true,

          error:
            "Le vrai template local n'est pas lisible.",
        });
    }

    /*
      SOUS-SCÉNARIO A

      Fingerprint officiel manquant.
      Baseline locale connue.
    */
    const missingOfficialFingerprint =
      evaluateScenario({
        scenarioKey:
          "missing_official_fingerprint",

        officialFingerprint:
          null,

        localFingerprint:
          local.local_fingerprint,
      });

    /*
      SOUS-SCÉNARIO B

      Fingerprint officiel connu.
      Baseline locale manquante.
    */
    const missingLocalBaseline =
      evaluateScenario({
        scenarioKey:
          "missing_local_baseline",

        officialFingerprint:
          official.official_fingerprint,

        localFingerprint:
          null,
      });

    const scenarios = [
      missingOfficialFingerprint,
      missingLocalBaseline,
    ];

    const everyScenarioPassed =
      scenarios.every(
        (scenario) =>
          scenario.status ===
            "untracked_baseline" &&
          allAssertionsTrue(
            scenario.assertions
          )
      );

    const globalStatus =
      everyScenarioPassed
        ? "untracked_baseline"
        : "test_failed";

    const globalRecommendedAction =
      everyScenarioPassed
        ? {
            action:
              "initialize_fingerprint_baseline",

            automatic_sync_allowed:
              false,

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
          everyScenarioPassed,

        message:
          everyScenarioPassed
            ? (
                "Test untracked_baseline réussi. " +
                "Le moteur bloque toute synchronisation " +
                "automatique lorsqu'un fingerprint officiel " +
                "ou une baseline locale manque."
              )
            : (
                "Test untracked_baseline non validé. " +
                "Au moins un sous-scénario a échoué."
              ),

        test:
          "untracked_baseline",

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
          official_fingerprint:
            official.official_fingerprint,

          local_fingerprint:
            local.local_fingerprint,

          official_fingerprint_exists:
            Boolean(
              official.official_fingerprint
            ),

          local_baseline_exists:
            Boolean(
              local.local_fingerprint
            ),

          template_exists:
            Boolean(realTemplate),

          page_readable:
            realPageReadable,
        },

        simulated_scenarios:
          scenarios,

        global_decision: {
          scenario_count:
            scenarios.length,

          passed_scenario_count:
            scenarios.filter(
              (scenario) =>
                scenario.status ===
                "untracked_baseline" &&
                allAssertionsTrue(
                  scenario.assertions
                )
            ).length,

          all_scenarios_passed:
            everyScenarioPassed,

          automatic_sync_allowed:
            false,
        },

        status:
          globalStatus,

        reason:
          everyScenarioPassed
            ? (
                "Une comparaison sûre exige à la fois " +
                "une référence officielle connue et une " +
                "baseline locale connue. Si l'une manque, " +
                "le moteur refuse toute synchronisation " +
                "destructive et recommande uniquement " +
                "l'initialisation contrôlée du tracking."
              )
            : (
                "Au moins un scénario de tracking incomplet " +
                "n'a pas produit la décision de sécurité attendue."
              ),

        recommended_action:
          globalRecommendedAction,

        assertions: {
          real_template_exists:
            Boolean(realTemplate),

          real_page_is_readable:
            realPageReadable,

          real_official_fingerprint_exists:
            Boolean(
              official.official_fingerprint
            ),

          real_local_baseline_exists:
            Boolean(
              local.local_fingerprint
            ),

          missing_official_fingerprint_detected:
            missingOfficialFingerprint
              .status ===
            "untracked_baseline",

          missing_local_baseline_detected:
            missingLocalBaseline
              .status ===
            "untracked_baseline",

          every_scenario_blocks_automatic_sync:
            scenarios.every(
              (scenario) =>
                scenario
                  .recommended_action
                  .automatic_sync_allowed ===
                false
            ),

          every_scenario_recommends_baseline_initialization:
            scenarios.every(
              (scenario) =>
                scenario
                  .recommended_action
                  .action ===
                "initialize_fingerprint_baseline"
            ),

          all_scenarios_passed:
            everyScenarioPassed,

          final_status_is_untracked_baseline:
            globalStatus ===
            "untracked_baseline",

          automatic_sync_is_blocked:
            globalRecommendedAction
              .automatic_sync_allowed ===
            false,
        },

        safety: {
          notion_write_operations: 0,
          neon_write_operations: 0,
          templates_modified: 0,
          templates_deleted: 0,
          pages_modified: 0,
          pages_deleted: 0,
          official_registry_modified: false,
          local_tracking_modified: false,
          fingerprints_modified: false,
          automatic_sync_executed: false,
        },
      });
  } catch (error) {
    console.error(
      "Erreur test untracked_baseline :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        test:
          "untracked_baseline",

        engine_stage:
          "1/6",

        dry_run: true,

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
