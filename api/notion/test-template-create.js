import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2026-03-11";

const TEST_TEMPLATE_KEY =
  "class_dashboard";

const LAB_PAGE_TITLE =
  "🧪 TEST TEMPORAIRE — TEMPLATE CREATE";

const LAB_TEMPLATE_NAME =
  "🧪 TEMPLATE TEMPORAIRE — API TEST";

const MAX_DEPTH = 10;

const POLL_INTERVAL_MS = 2000;

const MAX_POLL_ATTEMPTS = 15;

/*
  Prototype expérimental de création
  d'un véritable template de data source.

  Objectifs :
  - utiliser uniquement les IDs dynamiques
    enregistrés dans Neon ;
  - créer une page laboratoire ;
  - appliquer nativement un template existant ;
  - attendre la stabilisation ;
  - tester prudemment les opérations candidates
    de création d'un objet template ;
  - relister les templates après chaque tentative ;
  - ne jamais modifier les 5 templates officiels ;
  - nettoyer la page laboratoire.

  Important :
  - une erreur 404/405/400 sur une route candidate
    ne prouve pas l'impossibilité absolue de créer
    un template par toute API future ;
  - le résultat est donc classé avec prudence.
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

function sleep(ms) {
  return new Promise(
    (resolve) => setTimeout(resolve, ms)
  );
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

async function notionRequest(
  accessToken,
  path,
  options = {},
  throwOnError = true
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

  const result = {
    ok:
      response.ok,

    status:
      response.status,

    url,

    data,
  };

  if (
    !response.ok &&
    throwOnError
  ) {
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

  return result;
}

async function notion(
  accessToken,
  path,
  options = {}
) {
  const result =
    await notionRequest(
      accessToken,
      path,
      options,
      true
    );

  return result.data;
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
      template_key,
      component_key,
      notion_template_id,
      notion_data_source_id,
      notion_template_name,
      official_version,
      installed_version,
      sync_status,
      is_default
    FROM notion_workspace_templates
    WHERE
      workspace_id = ${workspaceId}
      AND template_key =
        ${TEST_TEMPLATE_KEY}
    LIMIT 1
  `;

  const template =
    templateRows[0];

  if (!template) {
    const error = new Error(
      "Le template officiel " +
      `« ${TEST_TEMPLATE_KEY} » ` +
      "n'est pas enregistré dans Neon."
    );

    error.statusCode = 409;

    throw error;
  }

  if (
    !template.notion_template_id ||
    !template.notion_data_source_id
  ) {
    const error = new Error(
      "Le template enregistré ne contient " +
      "pas tous les IDs nécessaires."
    );

    error.statusCode = 409;

    throw error;
  }

  return {
    connection,
    template,
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
    const item = {
      id:
        block.id || null,

      type:
        block.type || null,

      has_children:
        Boolean(block.has_children),
    };

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

function getTitlePropertyName(page) {
  const properties =
    page?.properties || {};

  for (
    const [propertyName, property]
    of Object.entries(properties)
  ) {
    if (property?.type === "title") {
      return propertyName;
    }
  }

  return null;
}

async function createLabPage(
  accessToken,
  template,
  templatePage
) {
  const titlePropertyName =
    getTitlePropertyName(
      templatePage
    );

  if (!titlePropertyName) {
    throw new Error(
      "Impossible d'identifier " +
      "la propriété title."
    );
  }

  return notion(
    accessToken,
    "/pages",
    {
      method: "POST",

      body: JSON.stringify({
        parent: {
          type:
            "data_source_id",

          data_source_id:
            template
              .notion_data_source_id,
        },

        properties: {
          [titlePropertyName]: {
            type: "title",

            title: [
              {
                type: "text",

                text: {
                  content:
                    LAB_PAGE_TITLE,
                },
              },
            ],
          },
        },
      }),
    }
  );
}

async function applyTemplateToPage(
  accessToken,
  pageId,
  templateId
) {
  return notion(
    accessToken,
    `/pages/${pageId}`,
    {
      method: "PATCH",

      body: JSON.stringify({
        template: {
          type: "template_id",

          template_id:
            templateId,
        },

        erase_content:
          true,
      }),
    }
  );
}

async function waitForStablePage(
  accessToken,
  pageId
) {
  let previousCount = null;
  let stableReads = 0;

  const polling = [];

  for (
    let attempt = 1;
    attempt <= MAX_POLL_ATTEMPTS;
    attempt += 1
  ) {
    const tree =
      await readBlockTree(
        accessToken,
        pageId
      );

    const count =
      countBlocks(tree);

    polling.push({
      attempt,
      recursive_block_count:
        count,
    });

    if (
      count > 0 &&
      count === previousCount
    ) {
      stableReads += 1;
    } else {
      stableReads = 0;
    }

    if (stableReads >= 1) {
      return {
        stable: true,
        attempts: attempt,
        recursive_block_count:
          count,
        polling,
      };
    }

    previousCount = count;

    if (
      attempt <
      MAX_POLL_ATTEMPTS
    ) {
      await sleep(
        POLL_INTERVAL_MS
      );
    }
  }

  return {
    stable: false,
    attempts:
      MAX_POLL_ATTEMPTS,
    recursive_block_count:
      previousCount || 0,
    polling,
  };
}

function findLabTemplate(
  templates
) {
  const expected =
    normalizeText(
      LAB_TEMPLATE_NAME
    );

  return templates.find(
    (template) =>
      normalizeText(
        template?.name
      ) === expected
  ) || null;
}

/*
  Tentatives expérimentales.

  On ne considère JAMAIS qu'une réponse 2xx
  suffit à prouver la création :
  après chaque tentative, le code reliste
  réellement les templates de la data source.

  Les routes testées sont isolées ici pour
  pouvoir les supprimer facilement après
  conclusion du prototype.
*/
async function runCandidateAttempts(
  accessToken,
  template,
  labPageId
) {
  const attempts = [];

  const candidates = [
    {
      key:
        "post_templates_collection",

      method:
        "POST",

      path:
        (
          `/data_sources/` +
          `${template.notion_data_source_id}` +
          `/templates`
        ),

      body: {
        name:
          LAB_TEMPLATE_NAME,

        source_page_id:
          labPageId,
      },
    },

    {
      key:
        "post_templates_collection_with_page",

      method:
        "POST",

      path:
        (
          `/data_sources/` +
          `${template.notion_data_source_id}` +
          `/templates`
        ),

      body: {
        name:
          LAB_TEMPLATE_NAME,

        page_id:
          labPageId,
      },
    },

    {
      key:
        "patch_page_as_template",

      method:
        "PATCH",

      path:
        `/pages/${labPageId}`,

      body: {
        is_template:
          true,

        template_name:
          LAB_TEMPLATE_NAME,
      },
    },
  ];

  for (const candidate of candidates) {
    const before =
      await listAllTemplates(
        accessToken,
        template.notion_data_source_id
      );

    const beforeIds =
      new Set(
        before
          .map((item) => item?.id)
          .filter(Boolean)
      );

    const response =
      await notionRequest(
        accessToken,
        candidate.path,
        {
          method:
            candidate.method,

          body:
            JSON.stringify(
              candidate.body
            ),
        },
        false
      );

    /*
      Petite attente avant vérification,
      car une éventuelle création pourrait
      être asynchrone.
    */
    await sleep(2000);

    const after =
      await listAllTemplates(
        accessToken,
        template.notion_data_source_id
      );

    const newTemplates =
      after.filter(
        (item) =>
          item?.id &&
          !beforeIds.has(item.id)
      );

    const namedLabTemplate =
      findLabTemplate(after);

    const creationObserved =
      newTemplates.length > 0 ||
      Boolean(namedLabTemplate);

    attempts.push({
      key:
        candidate.key,

      request: {
        method:
          candidate.method,

        path:
          candidate.path,

        /*
          On conserve le corps pour le diagnostic,
          sans token ni secret.
        */
        body:
          candidate.body,
      },

      response: {
        ok:
          response.ok,

        status:
          response.status,

        data:
          response.data,
      },

      verification: {
        template_count_before:
          before.length,

        template_count_after:
          after.length,

        new_template_count:
          newTemplates.length,

        new_templates:
          newTemplates.map(
            (item) => ({
              id:
                item?.id || null,

              name:
                item?.name || null,

              is_default:
                Boolean(
                  item?.is_default
                ),
            })
          ),

        named_lab_template_found:
          Boolean(namedLabTemplate),

        named_lab_template:
          namedLabTemplate
            ? {
                id:
                  namedLabTemplate.id ||
                  null,

                name:
                  namedLabTemplate.name ||
                  null,

                is_default:
                  Boolean(
                    namedLabTemplate
                      .is_default
                  ),
              }
            : null,

        creation_observed:
          creationObserved,
      },
    });

    /*
      Si une vraie création est observée,
      on arrête immédiatement les autres
      tentatives pour limiter les effets.
    */
    if (creationObserved) {
      break;
    }
  }

  return attempts;
}

function classifyCapability(
  attempts
) {
  const successfulCreation =
    attempts.find(
      (attempt) =>
        attempt.verification
          ?.creation_observed === true
    );

  if (successfulCreation) {
    return {
      status:
        "supported",

      proven:
        true,

      reason:
        "Un nouveau template a été observé " +
        "dans la liste réelle des templates " +
        "après une tentative d'écriture.",

      successful_attempt:
        successfulCreation.key,
    };
  }

  const allRejected =
    attempts.length > 0 &&
    attempts.every(
      (attempt) =>
        attempt.response?.ok !== true
    );

  if (allRejected) {
    return {
      status:
        "unsupported_by_tested_public_api",

      proven:
        false,

      reason:
        "Toutes les opérations candidates " +
        "testées ont été rejetées et aucun " +
        "nouveau template n'a été observé. " +
        "Cela ne prouve pas l'impossibilité " +
        "absolue via une API future ou non testée.",

      successful_attempt:
        null,
    };
  }

  return {
    status:
      "inconclusive",

    proven:
      false,

    reason:
      "Aucune création réelle n'a été observée, " +
      "mais au moins une réponse ne permet pas " +
      "de conclure proprement à un rejet total.",

    successful_attempt:
      null,
  };
}

async function trashPage(
  accessToken,
  pageId
) {
  return notion(
    accessToken,
    `/pages/${pageId}`,
    {
      method: "PATCH",

      body: JSON.stringify({
        in_trash:
          true,
      }),
    }
  );
}

export default async function handler(
  req,
  res
) {
  let accessToken = null;
  let labPageId = null;

  let cleanupAttempted = false;
  let cleanupSucceeded = false;
  let cleanupError = null;

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
      template,
    } = await getContext(req);

    accessToken =
      connection.access_token;

    /*
      1. Vérification initiale :
      le template laboratoire ne doit
      pas déjà exister, sinon le test
      serait ambigu.
    */
    const initialTemplates =
      await listAllTemplates(
        accessToken,
        template.notion_data_source_id
      );

    const existingLabTemplate =
      findLabTemplate(
        initialTemplates
      );

    if (existingLabTemplate) {
      const error = new Error(
        "Un template laboratoire portant déjà " +
        `le nom « ${LAB_TEMPLATE_NAME} » existe. ` +
        "Supprimez-le avant de relancer le test."
      );

      error.statusCode = 409;

      throw error;
    }

    /*
      2. Lire le template maître comme page.
    */
    const masterPage =
      await notion(
        accessToken,
        `/pages/${
          template.notion_template_id
        }`,
        {
          method: "GET",
        }
      );

    /*
      3. Créer la page laboratoire.
    */
    const labPage =
      await createLabPage(
        accessToken,
        template,
        masterPage
      );

    labPageId =
      labPage.id;

    if (!labPageId) {
      throw new Error(
        "La page laboratoire ne possède " +
        "aucun ID exploitable."
      );
    }

    /*
      4. Appliquer nativement
      le template existant.
    */
    await applyTemplateToPage(
      accessToken,
      labPageId,
      template.notion_template_id
    );

    /*
      5. Attendre la copie complète.
    */
    const stabilization =
      await waitForStablePage(
        accessToken,
        labPageId
      );

    if (!stabilization.stable) {
      const error = new Error(
        "La page laboratoire ne s'est pas " +
        "stabilisée dans le délai prévu."
      );

      error.statusCode = 504;

      throw error;
    }

    /*
      6. Exécuter les opérations candidates.
    */
    const attempts =
      await runCandidateAttempts(
        accessToken,
        template,
        labPageId
      );

    /*
      7. Classification prudente.
    */
    const capability =
      classifyCapability(
        attempts
      );

    /*
      8. Relire une dernière fois
      l'état réel des templates.
    */
    const finalTemplates =
      await listAllTemplates(
        accessToken,
        template.notion_data_source_id
      );

    const finalLabTemplate =
      findLabTemplate(
        finalTemplates
      );

    const responsePayload = {
      ok: true,

      message:
        "Test expérimental de création " +
        "de template terminé.",

      notion_api_version:
        NOTION_VERSION,

      workspace: {
        id:
          connection.workspace_id,

        name:
          connection.workspace_name ||
          null,
      },

      source_template: {
        template_key:
          template.template_key,

        component_key:
          template.component_key,

        name:
          template.notion_template_name,

        template_id:
          template.notion_template_id,

        data_source_id:
          template.notion_data_source_id,
      },

      laboratory: {
        page_id:
          labPageId,

        title:
          LAB_PAGE_TITLE,

        created:
          true,

        source_template_applied:
          true,

        stabilization,
      },

      capability: {
        create_new_template_object:
          capability.status,

        proven:
          capability.proven,

        reason:
          capability.reason,

        successful_attempt:
          capability
            .successful_attempt,
      },

      attempts,

      final_verification: {
        initial_template_count:
          initialTemplates.length,

        final_template_count:
          finalTemplates.length,

        lab_template_found:
          Boolean(finalLabTemplate),

        lab_template:
          finalLabTemplate
            ? {
                id:
                  finalLabTemplate.id ||
                  null,

                name:
                  finalLabTemplate.name ||
                  null,

                is_default:
                  Boolean(
                    finalLabTemplate
                      .is_default
                  ),
              }
            : null,
      },

      safety: {
        official_template_modified:
          false,

        official_template_deleted:
          false,

        existing_user_page_modified:
          false,

        laboratory_only:
          true,
      },

      cleanup: {
        attempted:
          false,

        succeeded:
          false,

        error:
          null,
      },
    };

    /*
      9. Nettoyage de la page laboratoire.
    */
    cleanupAttempted = true;

    try {
      await trashPage(
        accessToken,
        labPageId
      );

      cleanupSucceeded = true;

      responsePayload.cleanup = {
        attempted:
          true,

        succeeded:
          true,

        error:
          null,
      };

      labPageId = null;
    } catch (error) {
      cleanupError =
        error.message;

      responsePayload.cleanup = {
        attempted:
          true,

        succeeded:
          false,

        error:
          cleanupError,
      };
    }

    return res
      .status(200)
      .json(responsePayload);
  } catch (error) {
    console.error(
      "Erreur test création template :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        error:
          error.message ||
          "Erreur interne du serveur.",

        cleanup: {
          attempted:
            cleanupAttempted,

          succeeded:
            cleanupSucceeded,

          error:
            cleanupError,
        },
      });
  } finally {
    /*
      Filet de sécurité :
      si la page laboratoire existe encore,
      nouvelle tentative de mise à la corbeille.
    */
    if (
      accessToken &&
      labPageId
    ) {
      try {
        await trashPage(
          accessToken,
          labPageId
        );
      } catch (error) {
        console.error(
          "Échec nettoyage page laboratoire :",
          error
        );
      }
    }
  }
}
