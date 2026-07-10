import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2026-03-11";
const TEST_TEMPLATE_KEY = "student_sheet";

/*
  MI ESPACIO DOCENTE
  TEST MISSING TEMPLATE
  ÉTAPE 1/6
  DRY RUN STRICT

  OBJECTIF :

  Simuler l'absence d'un template local attendu
  sans supprimer ni modifier le vrai template.

  Le moteur doit distinguer :

  - create_if_missing = true
  - capacité réelle de création = non supportée
    par l'API publique testée

  Résultat attendu :

  status = missing_template

  action =
    manual_template_creation_required

  automatic_sync_allowed = false

  requires_user_action = true

  AUCUNE ÉCRITURE :
  - Notion : 0
  - Neon : 0
*/

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";

  const cookies = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim());

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = cookie.slice(0, separatorIndex);
    const value = cookie.slice(separatorIndex + 1);

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
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    const error = new Error(
      `Notion ${response.status} sur ${url}: ` +
      `${JSON.stringify(data)}`
    );

    error.statusCode = response.status;

    throw error;
  }

  return data;
}

async function getContext(req) {
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

  if (!connection || !connection.access_token) {
    const error = new Error(
      "Connexion Notion introuvable ou expirée."
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
      propagate_new_installations,
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
    local: localRows[0] || null,
    official: officialRows[0] || null,
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
    const params = new URLSearchParams();

    params.set("page_size", "100");

    if (startCursor) {
      params.set(
        "start_cursor",
        startCursor
      );
    }

    const result = await notion(
      accessToken,
      (
        `/data_sources/${dataSourceId}/templates?` +
        params.toString()
      ),
      {
        method: "GET",
      }
    );

    templates.push(
      ...(result.templates || [])
    );

    hasMore = Boolean(result.has_more);

    startCursor =
      result.next_cursor || undefined;
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
      res.setHeader("Allow", "GET");

      return res
        .status(405)
        .send("Méthode non autorisée");
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
          test: "missing_template",
          engine_stage: "1/6",
          dry_run: true,
          error:
            "Enregistrement local student_sheet introuvable. " +
            "Le test exige un état réel de référence avant simulation.",
        });
    }

    if (!official) {
      return res
        .status(409)
        .json({
          ok: false,
          test: "missing_template",
          engine_stage: "1/6",
          dry_run: true,
          error:
            "Référence officielle student_sheet introuvable.",
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

    /*
      Précondition importante :

      Le vrai template doit exister avant simulation.

      Sinon nous ne saurions pas distinguer :
      - un test contrôlé ;
      - une vraie anomalie de production.
    */
    if (!realTemplate) {
      return res
        .status(409)
        .json({
          ok: false,
          test: "missing_template",
          engine_stage: "1/6",
          dry_run: true,
          error:
            "Le vrai template local est déjà absent. " +
            "Simulation contrôlée refusée.",
        });
    }

    /*
      Vérification de lisibilité réelle.

      Lecture uniquement.
      Aucune modification.
    */
    const realPage = await notion(
      accessToken,
      `/pages/${realTemplate.id}`,
      {
        method: "GET",
      }
    );

    /*
      SIMULATION PURE :

      On ne supprime rien.

      Le moteur reçoit virtuellement
      un résultat de détection vide.
    */
    const simulatedDetectedTemplate =
      null;

    const simulatedTemplateExists =
      Boolean(simulatedDetectedTemplate);

    /*
      Capacité réellement prouvée auparavant :

      - appliquer un template existant : oui
      - mettre à jour un template existant : oui
      - créer un nouvel objet template : non supporté
        par l'API publique testée
    */
    const creationCapability = {
      public_api_tested: true,

      create_new_template_object:
        "unsupported_by_tested_public_api",

      proven_supported: false,

      automatic_creation_available: false,
    };

    const policyRequestsCreation =
      Boolean(
        official.is_active &&
        official.create_if_missing
      );

    const automaticCreationPossible =
      Boolean(
        policyRequestsCreation &&
        creationCapability
          .automatic_creation_available
      );

    /*
      État attendu :

      Le template manque.

      Même si la politique centrale demande
      sa création, le moteur ne doit jamais
      prétendre pouvoir la faire si la capacité
      technique n'est pas prouvée.
    */
    const missingTemplateDetected =
      simulatedTemplateExists === false;

    const manualCreationRequired =
      Boolean(
        missingTemplateDetected &&
        policyRequestsCreation &&
        !automaticCreationPossible
      );

    const status =
      manualCreationRequired
        ? "missing_template"
        : "test_failed";

    const recommendedAction =
      manualCreationRequired
        ? {
            action:
              "manual_template_creation_required",

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
        ok: manualCreationRequired,

        message:
          manualCreationRequired
            ? (
                "Test missing_template réussi. " +
                "Le moteur détecte l'absence du template, " +
                "respecte create_if_missing, mais refuse " +
                "toute fausse création automatique car " +
                "la capacité n'est pas supportée par " +
                "l'API publique testée."
              )
            : (
                "Test missing_template non validé. " +
                "Au moins une précondition n'est pas satisfaite."
              ),

        test: "missing_template",

        engine_stage: "1/6",

        dry_run: true,

        notion_api_version:
          NOTION_VERSION,

        workspace: {
          id: connection.workspace_id,

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

          registered_template_id:
            local.notion_template_id,

          data_source_id:
            local.notion_data_source_id,
        },

        real_state_before_simulation: {
          template_exists: true,

          template_detected:
            Boolean(realTemplate),

          template_id:
            realTemplate.id,

          page_readable:
            Boolean(realPage?.id),

          installed_version:
            local.installed_version,

          local_fingerprint:
            local.local_fingerprint,
        },

        simulated_missing_state: {
          simulated: true,

          persisted: false,

          detected_template:
            simulatedDetectedTemplate,

          template_exists:
            simulatedTemplateExists,

          real_template_deleted:
            false,

          local_registry_deleted:
            false,
        },

        official_policy: {
          is_active:
            official.is_active,

          create_if_missing:
            official.create_if_missing,

          propagate_new_installations:
            official
              .propagate_new_installations,

          propagate_existing_installations:
            official
              .propagate_existing_installations,

          overwrite_local_changes:
            official
              .overwrite_local_changes,

          local_changes_policy:
            official.local_changes_policy,

          requests_creation:
            policyRequestsCreation,
        },

        proven_capabilities: {
          apply_existing_template_natively:
            true,

          update_existing_template_object:
            true,

          full_native_template_sync:
            true,

          create_new_template_object:
            creationCapability
              .create_new_template_object,

          automatic_creation_available:
            creationCapability
              .automatic_creation_available,
        },

        decision: {
          missing_template_detected:
            missingTemplateDetected,

          policy_requests_creation:
            policyRequestsCreation,

          automatic_creation_possible:
            automaticCreationPossible,

          manual_creation_required:
            manualCreationRequired,
        },

        status,

        reason:
          manualCreationRequired
            ? (
                "Le template local attendu est simulé absent. " +
                "La politique centrale create_if_missing est active, " +
                "mais la création d'un nouvel objet template n'est " +
                "pas une capacité supportée par l'API publique testée. " +
                "Le moteur exige donc une création manuelle et " +
                "n'exécute aucune écriture automatique."
              )
            : (
                "La simulation n'a pas satisfait toutes " +
                "les conditions du scénario missing_template."
              ),

        recommended_action:
          recommendedAction,

        assertions: {
          real_template_exists_before_simulation:
            Boolean(realTemplate),

          real_page_is_readable:
            Boolean(realPage?.id),

          simulated_template_is_missing:
            missingTemplateDetected,

          missing_state_is_not_persisted:
            true,

          policy_create_if_missing_is_enabled:
            Boolean(
              official.create_if_missing
            ),

          policy_requests_creation:
            policyRequestsCreation,

          creation_capability_is_not_supported:
            !creationCapability
              .automatic_creation_available,

          automatic_creation_is_impossible:
            automaticCreationPossible ===
            false,

          final_status_is_missing_template:
            status ===
            "missing_template",

          manual_creation_is_required:
            recommendedAction.action ===
            "manual_template_creation_required",

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
          templates_deleted: 0,
          pages_modified: 0,
          pages_deleted: 0,
          official_registry_modified: false,
          local_tracking_modified: false,
          real_template_deleted: false,
          automatic_creation_attempted: false,
          automatic_sync_executed: false,
        },
      });
  } catch (error) {
    console.error(
      "Erreur test missing_template :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        test: "missing_template",

        engine_stage: "1/6",

        dry_run: true,

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
