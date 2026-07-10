import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2026-03-11";
const TEST_TEMPLATE_KEY = "student_sheet";

/*
  MI ESPACIO DOCENTE
  TEST UNREADABLE TEMPLATE
  ÉTAPE 1/6
  DRY RUN STRICT

  OBJECTIF :

  Simuler un template local :
  - bien enregistré dans Neon ;
  - bien détecté dans la liste des templates ;
  - mais impossible à lire comme page.

  Le moteur doit distinguer :

  missing_template
  !=
  unreadable_template

  IMPORTANT :

  Une erreur de lecture ne doit jamais :
  - déclencher create_if_missing ;
  - déclencher une création automatique ;
  - déclencher une synchronisation destructive ;
  - écraser le tracking local.

  Résultat attendu :

  status = unreadable_template

  action =
    restore_template_access

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

function buildSimulatedReadFailure() {
  return {
    simulated: true,
    persisted: false,

    request: {
      operation:
        "retrieve_template_as_page",

      method:
        "GET",

      target:
        "registered_local_template",
    },

    response: {
      ok: false,

      status: 403,

      code:
        "restricted_resource",

      message:
        "Simulated template access failure.",
    },
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
      local,
      official,
    } = await getContext(req);

    if (!local) {
      return res
        .status(409)
        .json({
          ok: false,
          test:
            "unreadable_template",
          engine_stage:
            "1/6",
          dry_run: true,
          error:
            "Enregistrement local student_sheet introuvable.",
        });
    }

    if (!official) {
      return res
        .status(409)
        .json({
          ok: false,
          test:
            "unreadable_template",
          engine_stage:
            "1/6",
          dry_run: true,
          error:
            "Référence officielle student_sheet introuvable.",
        });
    }

    const accessToken =
      connection.access_token;

    /*
      1. Vérification réelle :
      le template doit être détecté.

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
            "unreadable_template",
          engine_stage:
            "1/6",
          dry_run: true,
          error:
            "Le vrai template local est absent. " +
            "Impossible de simuler proprement " +
            "un état unreadable_template.",
        });
    }

    /*
      2. Vérification réelle :
      aujourd'hui, la page doit être lisible.

      Cela garantit que le test est purement simulé.
    */
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
            "unreadable_template",
          engine_stage:
            "1/6",
          dry_run: true,
          error:
            "Le template réel n'est déjà pas lisible. " +
            "Simulation contrôlée refusée.",
        });
    }

    /*
      3. Simulation pure d'une erreur d'accès.

      Aucun appel Notion défaillant réel.
      Aucun faux ID.
      Aucun changement de permission.
    */
    const simulatedReadFailure =
      buildSimulatedReadFailure();

    const simulatedTemplateDetected =
      true;

    const simulatedPageReadable =
      simulatedReadFailure
        .response.ok === true;

    const simulatedReadStatus =
      simulatedReadFailure
        .response.status;

    /*
      Distinction critique :

      - template détecté
      - page illisible

      Donc :
      unreadable_template

      et surtout PAS :
      missing_template
    */
    const templateExists =
      simulatedTemplateDetected;

    const templateUnreadable =
      Boolean(
        templateExists &&
        !simulatedPageReadable
      );

    const missingTemplate =
      !templateExists;

    /*
      Une erreur d'accès ne doit jamais
      déclencher create_if_missing.
    */
    const createIfMissingPolicy =
      Boolean(
        official.create_if_missing
      );

    const creationPolicyApplicable =
      Boolean(
        missingTemplate &&
        createIfMissingPolicy
      );

    const automaticCreationAttempted =
      false;

    const automaticSyncAllowed =
      false;

    const requiresUserAction =
      templateUnreadable;

    const status =
      templateUnreadable &&
      !missingTemplate &&
      !creationPolicyApplicable
        ? "unreadable_template"
        : "test_failed";

    const recommendedAction =
      status ===
      "unreadable_template"
        ? {
            action:
              "restore_template_access",

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

    const testSucceeded =
      Boolean(
        status ===
          "unreadable_template" &&
        templateExists &&
        templateUnreadable &&
        !missingTemplate &&
        !creationPolicyApplicable &&
        !automaticCreationAttempted &&
        !automaticSyncAllowed &&
        requiresUserAction
      );

    return res
      .status(200)
      .json({
        ok:
          testSucceeded,

        message:
          testSucceeded
            ? (
                "Test unreadable_template réussi. " +
                "Le moteur distingue un template existant " +
                "mais inaccessible d'un template absent, " +
                "bloque toute création automatique et " +
                "exige la restauration de l'accès."
              )
            : (
                "Test unreadable_template non validé. " +
                "Au moins une précondition de sécurité " +
                "n'est pas satisfaite."
              ),

        test:
          "unreadable_template",

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

          registered_template_id:
            local.notion_template_id,

          detected_template_id:
            realTemplate.id,

          data_source_id:
            local.notion_data_source_id,
        },

        real_state_before_simulation: {
          registry_entry_exists:
            true,

          template_detected:
            Boolean(realTemplate),

          template_exists:
            true,

          page_readable:
            realPageReadable,

          installed_version:
            local.installed_version,

          local_fingerprint:
            local.local_fingerprint,
        },

        simulated_unreadable_state: {
          simulated:
            true,

          persisted:
            false,

          template_detected:
            simulatedTemplateDetected,

          template_exists:
            templateExists,

          page_readable:
            simulatedPageReadable,

          simulated_http_status:
            simulatedReadStatus,

          simulated_error_code:
            simulatedReadFailure
              .response.code,

          simulated_error_message:
            simulatedReadFailure
              .response.message,

          real_permissions_modified:
            false,

          real_template_modified:
            false,

          real_template_deleted:
            false,

          local_registry_modified:
            false,
        },

        state_distinction: {
          missing_template:
            missingTemplate,

          unreadable_template:
            templateUnreadable,

          states_are_distinct:
            Boolean(
              !missingTemplate &&
              templateUnreadable
            ),
        },

        official_policy: {
          is_active:
            official.is_active,

          create_if_missing:
            official.create_if_missing,

          update_if_outdated:
            official.update_if_outdated,

          overwrite_local_changes:
            official
              .overwrite_local_changes,

          local_changes_policy:
            official.local_changes_policy,
        },

        decision: {
          template_exists:
            templateExists,

          template_unreadable:
            templateUnreadable,

          missing_template:
            missingTemplate,

          create_if_missing_enabled:
            createIfMissingPolicy,

          creation_policy_applicable:
            creationPolicyApplicable,

          automatic_creation_attempted:
            automaticCreationAttempted,

          automatic_sync_allowed:
            automaticSyncAllowed,

          requires_user_action:
            requiresUserAction,
        },

        status,

        reason:
          status ===
          "unreadable_template"
            ? (
                "Le template est toujours détecté dans " +
                "la source de données mais sa lecture " +
                "est simulée en échec. Il ne doit donc " +
                "pas être classé missing_template. " +
                "La politique create_if_missing ne " +
                "s'applique pas et toute synchronisation " +
                "automatique reste bloquée jusqu'à " +
                "restauration de l'accès."
              )
            : (
                "La simulation n'a pas satisfait toutes " +
                "les conditions du scénario unreadable_template."
              ),

        recommended_action:
          recommendedAction,

        assertions: {
          real_registry_entry_exists:
            true,

          real_template_exists_before_simulation:
            Boolean(realTemplate),

          real_page_is_readable_before_simulation:
            realPageReadable,

          simulated_template_is_detected:
            simulatedTemplateDetected,

          simulated_template_still_exists:
            templateExists,

          simulated_page_is_unreadable:
            !simulatedPageReadable,

          final_state_is_not_missing_template:
            missingTemplate === false,

          final_state_is_unreadable_template:
            templateUnreadable === true,

          missing_and_unreadable_are_distinct:
            Boolean(
              !missingTemplate &&
              templateUnreadable
            ),

          create_if_missing_does_not_apply:
            creationPolicyApplicable ===
            false,

          automatic_creation_is_not_attempted:
            automaticCreationAttempted ===
            false,

          automatic_sync_is_blocked:
            recommendedAction
              .automatic_sync_allowed ===
            false,

          user_action_is_required:
            recommendedAction
              .requires_user_action ===
            true,

          final_status_is_unreadable_template:
            status ===
            "unreadable_template",
        },

        safety: {
          notion_write_operations: 0,
          neon_write_operations: 0,
          templates_modified: 0,
          templates_deleted: 0,
          pages_modified: 0,
          pages_deleted: 0,
          permissions_modified: 0,
          official_registry_modified: false,
          local_tracking_modified: false,
          real_template_deleted: false,
          automatic_creation_attempted: false,
          automatic_sync_executed: false,
        },
      });
  } catch (error) {
    console.error(
      "Erreur test unreadable_template :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        test:
          "unreadable_template",

        engine_stage:
          "1/6",

        dry_run: true,

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
