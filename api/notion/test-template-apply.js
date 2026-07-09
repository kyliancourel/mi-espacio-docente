import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2026-03-11";

const TEST_TEMPLATE_KEY =
  "class_dashboard";

const LAB_PAGE_TITLE =
  "🧪 TEST TEMPORAIRE — TEMPLATE APPLY";

const MAX_DEPTH = 10;

const POLL_INTERVAL_MS = 2000;

const MAX_POLL_ATTEMPTS = 15;

/*
  Test laboratoire sécurisé.

  Objectif :
  - récupérer class_dashboard depuis Neon ;
  - lire le template maître ;
  - créer une page temporaire ;
  - appliquer nativement le template ;
  - attendre l'instanciation ;
  - lire récursivement la page générée ;
  - comparer maître et résultat ;
  - mettre la page test à la corbeille.

  Important :
  - aucun ID Notion codé en dur ;
  - aucun template maître modifié ;
  - aucune base existante modifiée ;
  - une seule page laboratoire créée ;
  - nettoyage tenté dans un finally.
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
      "n'est pas enregistré dans Neon. " +
      "Lancez d'abord /api/notion/setup."
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
      "pas tous les IDs Notion nécessaires."
    );

    error.statusCode = 409;

    throw error;
  }

  return {
    connection,
    template,
  };
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

      archived:
        Boolean(block.archived),

      in_trash:
        Boolean(block.in_trash),
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

function collectBlockTypes(
  tree = [],
  counts = {}
) {
  for (const block of tree) {
    const type =
      block.type || "unknown";

    counts[type] =
      (counts[type] || 0) + 1;

    if (
      Array.isArray(block.children)
    ) {
      collectBlockTypes(
        block.children,
        counts
      );
    }
  }

  return counts;
}

function sumTypeCounts(
  counts = {}
) {
  return Object.values(counts)
    .reduce(
      (total, value) =>
        total + Number(value || 0),
      0
    );
}

function compareTypeCounts(
  masterCounts,
  generatedCounts
) {
  const allTypes =
    new Set([
      ...Object.keys(
        masterCounts || {}
      ),

      ...Object.keys(
        generatedCounts || {}
      ),
    ]);

  const comparison = {};

  for (const type of allTypes) {
    const master =
      masterCounts?.[type] || 0;

    const generated =
      generatedCounts?.[type] || 0;

    comparison[type] = {
      master,
      generated,

      difference:
        generated - master,

      exact:
        generated === master,
    };
  }

  return comparison;
}

function countExactTypes(
  comparison = {}
) {
  return Object.values(comparison)
    .filter(
      (item) =>
        item.exact === true
    )
    .length;
}

function countDifferentTypes(
  comparison = {}
) {
  return Object.values(comparison)
    .filter(
      (item) =>
        item.exact !== true
    )
    .length;
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

/*
  Crée une page laboratoire vide.

  On récupère d'abord le template comme page
  afin d'identifier la propriété title réelle
  de la data source cible.
*/
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
      "Impossible d'identifier la propriété " +
      "title de la data source cible."
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

/*
  Application native du template
  à la page laboratoire existante.

  erase_content = true :
  la page laboratoire vient d'être créée
  pour ce test et ne contient aucun contenu
  utilisateur à protéger.
*/
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

/*
  Attend l'application asynchrone.

  On considère la page stabilisée lorsque :
  - elle contient des blocs ;
  - le nombre récursif reste identique
    pendant deux lectures consécutives.

  Cela évite de conclure trop tôt pendant
  l'instanciation native du template.
*/
async function waitForStableBlockTree(
  accessToken,
  pageId
) {
  let previousCount = null;
  let stableReads = 0;
  let latestTree = [];
  let latestCount = 0;

  const polling = [];

  for (
    let attempt = 1;
    attempt <= MAX_POLL_ATTEMPTS;
    attempt += 1
  ) {
    latestTree =
      await readBlockTree(
        accessToken,
        pageId
      );

    latestCount =
      countBlocks(latestTree);

    polling.push({
      attempt,
      recursive_block_count:
        latestCount,
    });

    if (
      latestCount > 0 &&
      previousCount === latestCount
    ) {
      stableReads += 1;
    } else {
      stableReads = 0;
    }

    if (stableReads >= 1) {
      return {
        stable: true,

        attempts:
          attempt,

        tree:
          latestTree,

        recursive_block_count:
          latestCount,

        polling,
      };
    }

    previousCount =
      latestCount;

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

    tree:
      latestTree,

    recursive_block_count:
      latestCount,

    polling,
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
        in_trash: true,
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
      1. Lire le template maître
      comme page.
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
      2. Lire récursivement
      le template maître.
    */
    const masterTree =
      await readBlockTree(
        accessToken,
        template.notion_template_id
      );

    const masterBlockCount =
      countBlocks(masterTree);

    const masterBlockTypes =
      collectBlockTypes(
        masterTree
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
        "La page laboratoire a été créée " +
        "sans identifiant exploitable."
      );
    }

    /*
      4. Appliquer nativement
      le template officiel.
    */
    const applyResult =
      await applyTemplateToPage(
        accessToken,
        labPageId,
        template.notion_template_id
      );

    /*
      5. Attendre la stabilisation.
    */
    const stabilization =
      await waitForStableBlockTree(
        accessToken,
        labPageId
      );

    const generatedTree =
      stabilization.tree;

    const generatedBlockCount =
      countBlocks(
        generatedTree
      );

    const generatedBlockTypes =
      collectBlockTypes(
        generatedTree
      );

    /*
      6. Comparaison structurelle.
    */
    const typeComparison =
      compareTypeCounts(
        masterBlockTypes,
        generatedBlockTypes
      );

    const masterTypeTotal =
      sumTypeCounts(
        masterBlockTypes
      );

    const generatedTypeTotal =
      sumTypeCounts(
        generatedBlockTypes
      );

    const unsupportedMaster =
      masterBlockTypes.unsupported ||
      0;

    const unsupportedGenerated =
      generatedBlockTypes.unsupported ||
      0;

    const childDatabaseMaster =
      masterBlockTypes.child_database ||
      0;

    const childDatabaseGenerated =
      generatedBlockTypes.child_database ||
      0;

    const exactBlockCount =
      masterBlockCount ===
      generatedBlockCount;

    const exactTypeDistribution =
      countDifferentTypes(
        typeComparison
      ) === 0;

    const criticalUnsupportedPreserved =
      unsupportedMaster ===
      unsupportedGenerated;

    const criticalChildDatabasesPreserved =
      childDatabaseMaster ===
      childDatabaseGenerated;

    const structurallyEquivalent =
      exactBlockCount &&
      exactTypeDistribution;

    /*
      7. Réponse préparée avant finally.

      Le finally tentera toujours
      de mettre la page à la corbeille.
    */
    const responsePayload = {
      ok: true,

      message:
        "Test d'application native " +
        "du template terminé.",

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
          template.template_key,

        component_key:
          template.component_key,

        name:
          template.notion_template_name,

        template_id:
          template.notion_template_id,

        data_source_id:
          template.notion_data_source_id,

        official_version:
          template.official_version,

        installed_version:
          template.installed_version,

        sync_status:
          template.sync_status,
      },

      laboratory: {
        page_id:
          labPageId,

        title:
          LAB_PAGE_TITLE,

        created:
          true,

        template_apply_request_accepted:
          Boolean(applyResult),

        stabilization: {
          stable:
            stabilization.stable,

          attempts:
            stabilization.attempts,

          polling:
            stabilization.polling,
        },
      },

      master: {
        recursive_block_count:
          masterBlockCount,

        type_total:
          masterTypeTotal,

        block_types:
          masterBlockTypes,
      },

      generated: {
        recursive_block_count:
          generatedBlockCount,

        type_total:
          generatedTypeTotal,

        block_types:
          generatedBlockTypes,
      },

      comparison: {
        exact_block_count:
          exactBlockCount,

        exact_type_distribution:
          exactTypeDistribution,

        structurally_equivalent:
          structurallyEquivalent,

        exact_type_count:
          countExactTypes(
            typeComparison
          ),

        different_type_count:
          countDifferentTypes(
            typeComparison
          ),

        critical_checks: {
          unsupported: {
            master:
              unsupportedMaster,

            generated:
              unsupportedGenerated,

            preserved:
              criticalUnsupportedPreserved,
          },

          child_database: {
            master:
              childDatabaseMaster,

            generated:
              childDatabaseGenerated,

            preserved:
              criticalChildDatabasesPreserved,
          },
        },

        by_type:
          typeComparison,
      },

      capability_test: {
        retrieve_template_as_page:
          true,

        read_template_blocks:
          true,

        create_lab_page:
          true,

        apply_existing_template_natively:
          true,

        wait_for_async_instantiation:
          stabilization.stable,

        compare_generated_structure:
          true,

        preserve_unsupported_blocks:
          criticalUnsupportedPreserved,

        preserve_child_databases:
          criticalChildDatabasesPreserved,

        native_instantiation_structurally_equivalent:
          structurallyEquivalent,

        create_new_template_object:
          "not_tested",

        update_existing_template_object:
          "not_tested",
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
      Nettoyage immédiat ici afin que
      la réponse JSON puisse confirmer
      le résultat du nettoyage.

      Le finally reste une seconde
      protection si ce nettoyage échoue.
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

      /*
        Empêche un second nettoyage
        inutile dans finally.
      */
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
      "Erreur test application template :",
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
      Filet de sécurité.

      Si une page laboratoire existe encore,
      on tente de la mettre à la corbeille.

      Attention :
      si la réponse HTTP est déjà partie,
      ce résultat ne pourra pas être ajouté
      au JSON retourné, mais le nettoyage
      sera tout de même tenté.
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
