import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2026-03-11";

const SOURCE_TEMPLATE_KEY =
  "class_dashboard";

const TARGET_TEMPLATE_NAME =
  "🧪 TEMPLATE LABORATOIRE — FULL SYNC TEST";

const MAX_DEPTH = 20;

const POLL_INTERVAL_MS = 2000;

const MAX_POLL_ATTEMPTS = 20;

const REQUIRED_STABLE_READS = 2;

/*
  TEST DE SYNCHRONISATION NATIVE COMPLÈTE
  D'UN TEMPLATE EXISTANT.

  Objectif :
  - prendre le template officiel
    class_dashboard comme maître ;
  - détecter un template laboratoire
    existant dans la même data source ;
  - mesurer le maître récursivement ;
  - mesurer la cible avant modification ;
  - appliquer NATIVEMENT le maître
    directement sur l'objet template cible ;
  - utiliser erase_content: true ;
  - attendre l'instanciation asynchrone ;
  - mesurer la cible après synchronisation ;
  - comparer précisément les structures.

  IMPORTANT :
  - le template laboratoire cible est
    volontairement sacrificiel ;
  - son contenu sera remplacé ;
  - aucun template officiel n'est modifié ;
  - aucune page utilisateur n'est modifiée ;
  - aucun moteur manuel de copie de blocs
    n'est utilisé.

  Ce test cherche à prouver le scénario réel :

    template maître officiel
            ↓
    application native par template_id
            ↓
    template existant chez l'utilisateur
            ↓
    remplacement complet du contenu
            ↓
    comparaison structurelle
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
      sync_status
    FROM notion_workspace_templates
    WHERE
      workspace_id = ${workspaceId}
      AND template_key =
        ${SOURCE_TEMPLATE_KEY}
    LIMIT 1
  `;

  const sourceTemplate =
    templateRows[0];

  if (!sourceTemplate) {
    const error = new Error(
      "Le template officiel " +
      `« ${SOURCE_TEMPLATE_KEY} » ` +
      "n'est pas enregistré dans Neon."
    );

    error.statusCode = 409;

    throw error;
  }

  if (
    !sourceTemplate.notion_template_id ||
    !sourceTemplate.notion_data_source_id
  ) {
    const error = new Error(
      "Le template source enregistré " +
      "ne contient pas tous les IDs nécessaires."
    );

    error.statusCode = 409;

    throw error;
  }

  return {
    connection,
    sourceTemplate,
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

function findExactTemplateMatches(
  templates,
  expectedName
) {
  const normalizedExpected =
    normalizeText(
      expectedName
    );

  return templates.filter(
    (template) =>
      normalizeText(
        template?.name
      ) === normalizedExpected
  );
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

function sortObjectKeys(object = {}) {
  return Object.fromEntries(
    Object.entries(object)
      .sort(
        ([a], [b]) =>
          a.localeCompare(b)
      )
  );
}

function buildSnapshot(tree = []) {
  const blockTypes =
    sortObjectKeys(
      countBlockTypes(tree, {})
    );

  return {
    recursive_block_count:
      countBlocks(tree),

    type_total:
      Object.values(
        blockTypes
      ).reduce(
        (sum, count) =>
          sum + count,
        0
      ),

    block_types:
      blockTypes,
  };
}

function compareSnapshots(
  master,
  target
) {
  const allTypes =
    Array.from(
      new Set([
        ...Object.keys(
          master.block_types || {}
        ),

        ...Object.keys(
          target.block_types || {}
        ),
      ])
    ).sort();

  const byType = {};

  let exactTypeCount = 0;
  let differentTypeCount = 0;

  for (const type of allTypes) {
    const masterCount =
      master.block_types?.[type] || 0;

    const targetCount =
      target.block_types?.[type] || 0;

    const exact =
      masterCount === targetCount;

    if (exact) {
      exactTypeCount += 1;
    } else {
      differentTypeCount += 1;
    }

    byType[type] = {
      master:
        masterCount,

      target:
        targetCount,

      difference:
        targetCount - masterCount,

      exact,
    };
  }

  const exactBlockCount =
    master.recursive_block_count ===
    target.recursive_block_count;

  const exactTypeDistribution =
    differentTypeCount === 0;

  const structurallyEquivalent =
    exactBlockCount &&
    exactTypeDistribution;

  return {
    exact_block_count:
      exactBlockCount,

    exact_type_distribution:
      exactTypeDistribution,

    structurally_equivalent:
      structurallyEquivalent,

    exact_type_count:
      exactTypeCount,

    different_type_count:
      differentTypeCount,

    critical_checks: {
      unsupported: {
        master:
          master.block_types
            ?.unsupported || 0,

        target:
          target.block_types
            ?.unsupported || 0,

        preserved:
          (
            master.block_types
              ?.unsupported || 0
          ) ===
          (
            target.block_types
              ?.unsupported || 0
          ),
      },

      child_database: {
        master:
          master.block_types
            ?.child_database || 0,

        target:
          target.block_types
            ?.child_database || 0,

        preserved:
          (
            master.block_types
              ?.child_database || 0
          ) ===
          (
            target.block_types
              ?.child_database || 0
          ),
      },
    },

    by_type:
      byType,
  };
}

async function applyTemplateNatively(
  accessToken,
  targetTemplateId,
  sourceTemplateId
) {
  return notionRequest(
    accessToken,
    `/pages/${targetTemplateId}`,
    {
      method: "PATCH",

      body: JSON.stringify({
        template: {
          type:
            "template_id",

          template_id:
            sourceTemplateId,
        },

        erase_content:
          true,
      }),
    },
    false
  );
}

async function waitForStableSnapshot(
  accessToken,
  targetId
) {
  let previousSignature = null;
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
        targetId
      );

    const snapshot =
      buildSnapshot(tree);

    const signature =
      JSON.stringify(snapshot);

    if (
      snapshot.recursive_block_count > 0 &&
      signature === previousSignature
    ) {
      stableReads += 1;
    } else {
      stableReads = 0;
    }

    polling.push({
      attempt,

      recursive_block_count:
        snapshot.recursive_block_count,

      type_total:
        snapshot.type_total,

      block_types:
        snapshot.block_types,

      stable_reads:
        stableReads,
    });

    if (
      stableReads >=
      REQUIRED_STABLE_READS
    ) {
      return {
        stable: true,

        attempts:
          attempt,

        required_stable_reads:
          REQUIRED_STABLE_READS,

        snapshot,

        tree,

        polling,
      };
    }

    previousSignature =
      signature;

    if (
      attempt <
      MAX_POLL_ATTEMPTS
    ) {
      await sleep(
        POLL_INTERVAL_MS
      );
    }
  }

  const finalTree =
    await readBlockTree(
      accessToken,
      targetId
    );

  return {
    stable: false,

    attempts:
      MAX_POLL_ATTEMPTS,

    required_stable_reads:
      REQUIRED_STABLE_READS,

    snapshot:
      buildSnapshot(finalTree),

    tree:
      finalTree,

    polling,
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

    /*
      1. Charger le workspace
      et le template maître dynamique.
    */
    const {
      connection,
      sourceTemplate,
    } = await getContext(req);

    const accessToken =
      connection.access_token;

    /*
      2. Lister les templates réels
      de la data source.
    */
    const templates =
      await listAllTemplates(
        accessToken,
        sourceTemplate
          .notion_data_source_id
      );

    /*
      3. Détecter exactement
      la cible laboratoire.
    */
    const targetMatches =
      findExactTemplateMatches(
        templates,
        TARGET_TEMPLATE_NAME
      );

    if (
      targetMatches.length === 0
    ) {
      const error = new Error(
        "Le template laboratoire " +
        `« ${TARGET_TEMPLATE_NAME} » ` +
        "est introuvable dans la data source Classes."
      );

      error.statusCode = 404;

      throw error;
    }

    if (
      targetMatches.length > 1
    ) {
      const error = new Error(
        "Plusieurs templates portent exactement " +
        `le nom « ${TARGET_TEMPLATE_NAME} ». ` +
        "Le test est refusé par sécurité."
      );

      error.statusCode = 409;

      throw error;
    }

    const targetTemplate =
      targetMatches[0];

    const targetTemplateId =
      targetTemplate.id;

    if (!targetTemplateId) {
      throw new Error(
        "Le template laboratoire cible " +
        "ne possède aucun ID exploitable."
      );
    }

    /*
      4. Sécurité absolue :
      source et cible doivent être distinctes.
    */
    if (
      targetTemplateId ===
      sourceTemplate.notion_template_id
    ) {
      const error = new Error(
        "Refus de sécurité : le template cible " +
        "est identique au template maître."
      );

      error.statusCode = 409;

      throw error;
    }

    /*
      5. Vérifier que le maître
      est bien lisible comme page.
    */
    const masterPage =
      await notion(
        accessToken,
        `/pages/${
          sourceTemplate.notion_template_id
        }`,
        {
          method: "GET",
        }
      );

    /*
      6. Vérifier que la cible
      est bien lisible comme page.
    */
    const targetPageBefore =
      await notion(
        accessToken,
        `/pages/${targetTemplateId}`,
        {
          method: "GET",
        }
      );

    /*
      7. Lire et mesurer
      le template maître.
    */
    const masterTree =
      await readBlockTree(
        accessToken,
        sourceTemplate
          .notion_template_id
      );

    const masterSnapshot =
      buildSnapshot(
        masterTree
      );

    /*
      8. Lire et mesurer
      la cible AVANT synchronisation.
    */
    const targetTreeBefore =
      await readBlockTree(
        accessToken,
        targetTemplateId
      );

    const targetSnapshotBefore =
      buildSnapshot(
        targetTreeBefore
      );

    /*
      9. Comparaison avant.
    */
    const comparisonBefore =
      compareSnapshots(
        masterSnapshot,
        targetSnapshotBefore
      );

    /*
      10. TEST DÉCISIF :
      appliquer nativement le maître
      directement sur le template cible.
    */
    const applyResponse =
      await applyTemplateNatively(
        accessToken,
        targetTemplateId,
        sourceTemplate
          .notion_template_id
      );

    if (!applyResponse.ok) {
      return res
        .status(200)
        .json({
          ok: true,

          message:
            "Test de synchronisation complète terminé : " +
            "la requête native d'application sur un " +
            "template existant a été rejetée.",

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
              sourceTemplate.template_key,

            name:
              sourceTemplate
                .notion_template_name,

            template_id:
              sourceTemplate
                .notion_template_id,

            data_source_id:
              sourceTemplate
                .notion_data_source_id,
          },

          target_template: {
            name:
              targetTemplate.name,

            template_id:
              targetTemplateId,

            page_readable:
              Boolean(
                targetPageBefore?.id
              ),
          },

          before: {
            master:
              masterSnapshot,

            target:
              targetSnapshotBefore,

            comparison:
              comparisonBefore,
          },

          native_apply: {
            accepted:
              false,

            status:
              applyResponse.status,

            response:
              applyResponse.data,
          },

          capability: {
            full_native_template_sync:
              "unsupported_by_test",

            proven:
              false,

            reason:
              "La requête native d'application " +
              "du template maître directement " +
              "sur le template cible a été rejetée.",
          },

          safety: {
            official_template_modified:
              false,

            official_template_deleted:
              false,

            existing_user_page_modified:
              false,

            laboratory_template_only:
              true,
          },
        });
    }

    /*
      11. L'application native peut être
      asynchrone : attendre la stabilisation.
    */
    const stabilization =
      await waitForStableSnapshot(
        accessToken,
        targetTemplateId
      );

    /*
      12. Mesure finale.
    */
    const targetSnapshotAfter =
      stabilization.snapshot;

    /*
      13. Comparaison finale.
    */
    const comparisonAfter =
      compareSnapshots(
        masterSnapshot,
        targetSnapshotAfter
      );

    /*
      14. Vérifier que la cible
      existe toujours comme template
      dans la liste réelle.
    */
    const templatesAfter =
      await listAllTemplates(
        accessToken,
        sourceTemplate
          .notion_data_source_id
      );

    const targetMatchesAfter =
      findExactTemplateMatches(
        templatesAfter,
        TARGET_TEMPLATE_NAME
      );

    const targetStillRegistered =
      targetMatchesAfter.some(
        (template) =>
          template.id ===
          targetTemplateId
      );

    /*
      15. Vérifier aussi que la cible
      reste lisible comme page.
    */
    let targetStillPageReadable = false;

    try {
      const targetPageAfter =
        await notion(
          accessToken,
          `/pages/${targetTemplateId}`,
          {
            method: "GET",
          }
        );

      targetStillPageReadable =
        Boolean(
          targetPageAfter?.id
        );
    } catch {
      targetStillPageReadable =
        false;
    }

    /*
      16. Conclusion stricte.
    */
    const fullSyncProven =
      Boolean(
        applyResponse.ok &&
        stabilization.stable &&
        comparisonAfter
          .structurally_equivalent &&
        comparisonAfter
          .critical_checks
          .unsupported
          .preserved &&
        comparisonAfter
          .critical_checks
          .child_database
          .preserved &&
        targetStillRegistered &&
        targetStillPageReadable
      );

    return res
      .status(200)
      .json({
        ok: true,

        message:
          fullSyncProven
            ? (
                "Synchronisation native complète " +
                "d'un template existant prouvée."
              )
            : (
                "Test de synchronisation native " +
                "terminé, mais l'équivalence complète " +
                "n'est pas prouvée."
              ),

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
            sourceTemplate.template_key,

          component_key:
            sourceTemplate.component_key,

          name:
            sourceTemplate
              .notion_template_name,

          template_id:
            sourceTemplate
              .notion_template_id,

          data_source_id:
            sourceTemplate
              .notion_data_source_id,

          official_version:
            sourceTemplate
              .official_version ||
            null,

          page_readable:
            Boolean(
              masterPage?.id
            ),
        },

        target_template: {
          name:
            targetTemplate.name,

          template_id:
            targetTemplateId,

          page_readable_before:
            Boolean(
              targetPageBefore?.id
            ),

          page_readable_after:
            targetStillPageReadable,

          still_registered_as_template:
            targetStillRegistered,

          destructive_test_target:
            true,
        },

        before: {
          master:
            masterSnapshot,

          target:
            targetSnapshotBefore,

          comparison:
            comparisonBefore,
        },

        native_apply: {
          accepted:
            applyResponse.ok,

          status:
            applyResponse.status,

          erase_content:
            true,

          source_template_id:
            sourceTemplate
              .notion_template_id,

          target_template_id:
            targetTemplateId,
        },

        stabilization: {
          stable:
            stabilization.stable,

          attempts:
            stabilization.attempts,

          required_stable_reads:
            stabilization
              .required_stable_reads,

          polling:
            stabilization.polling,
        },

        after: {
          master:
            masterSnapshot,

          target:
            targetSnapshotAfter,

          comparison:
            comparisonAfter,
        },

        capability: {
          full_native_template_sync:
            fullSyncProven
              ? "supported"
              : "inconclusive",

          proven:
            fullSyncProven,

          apply_master_template_to_existing_template:
            applyResponse.ok,

          erase_existing_template_content:
            applyResponse.ok,

          target_stabilized:
            stabilization.stable,

          exact_block_count:
            comparisonAfter
              .exact_block_count,

          exact_type_distribution:
            comparisonAfter
              .exact_type_distribution,

          structurally_equivalent:
            comparisonAfter
              .structurally_equivalent,

          preserve_unsupported_blocks:
            comparisonAfter
              .critical_checks
              .unsupported
              .preserved,

          preserve_child_databases:
            comparisonAfter
              .critical_checks
              .child_database
              .preserved,

          target_remains_registered_as_template:
            targetStillRegistered,

          target_remains_page_readable:
            targetStillPageReadable,
        },

        safety: {
          official_template_modified:
            false,

          official_template_deleted:
            false,

          existing_user_page_modified:
            false,

          laboratory_template_only:
            true,

          target_content_replaced:
            true,

          automatic_restoration:
            false,

          note:
            "Le template laboratoire cible est " +
            "sacrificiel. Son contenu a été remplacé " +
            "par le template maître si la requête " +
            "native a été acceptée.",
        },
      });
  } catch (error) {
    console.error(
      "Erreur test full sync template :",
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
      });
  }
}
