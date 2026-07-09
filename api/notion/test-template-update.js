import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2026-03-11";

const SOURCE_TEMPLATE_KEY =
  "class_dashboard";

const LAB_TEMPLATE_NAME =
  "🧪 TEMPLATE LABORATOIRE — UPDATE TEST";

const INITIAL_TEXT =
  "ÉTAT INITIAL — NE PAS SUPPRIMER";

const TEMP_MARKER =
  "🧪 MARQUEUR API TEMPORAIRE — UPDATE TEST";

const POLL_INTERVAL_MS = 1500;

const MAX_POLL_ATTEMPTS = 10;

/*
  Test réversible de mise à jour
  d'un template existant.

  Précondition :
  - un template laboratoire existe
    manuellement dans la même data source
    que class_dashboard ;
  - son nom exact est :
      🧪 TEMPLATE LABORATOIRE — UPDATE TEST
  - il contient le paragraphe :
      ÉTAT INITIAL — NE PAS SUPPRIMER

  Le test :
  1. détecte le template laboratoire ;
  2. vérifie le texte initial ;
  3. ajoute un paragraphe temporaire
     directement dans le template ;
  4. vérifie qu'il est réellement lisible ;
  5. supprime le marqueur temporaire ;
  6. vérifie sa disparition ;
  7. confirme que le texte initial subsiste.

  Aucun template officiel n'est modifié.
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
      notion_template_name
    FROM notion_workspace_templates
    WHERE
      workspace_id = ${workspaceId}
      AND template_key =
        ${SOURCE_TEMPLATE_KEY}
    LIMIT 1
  `;

  const sourceTemplate =
    templateRows[0];

  if (
    !sourceTemplate ||
    !sourceTemplate.notion_data_source_id
  ) {
    const error = new Error(
      "Le template source class_dashboard " +
      "n'est pas correctement enregistré."
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

function findLabTemplates(
  templates
) {
  const expectedName =
    normalizeText(
      LAB_TEMPLATE_NAME
    );

  return templates.filter(
    (template) =>
      normalizeText(
        template?.name
      ) === expectedName
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

function getRichTextPlainText(
  richText = []
) {
  return richText
    .map(
      (item) =>
        item?.plain_text ||
        item?.text?.content ||
        ""
    )
    .join("");
}

function getBlockPlainText(block) {
  const type =
    block?.type;

  if (!type) {
    return "";
  }

  const payload =
    block[type];

  if (
    !payload ||
    !Array.isArray(payload.rich_text)
  ) {
    return "";
  }

  return getRichTextPlainText(
    payload.rich_text
  );
}

function findBlocksByExactText(
  blocks,
  expectedText
) {
  const expected =
    normalizeText(
      expectedText
    );

  return blocks.filter(
    (block) =>
      normalizeText(
        getBlockPlainText(block)
      ) === expected
  );
}

async function appendTemporaryMarker(
  accessToken,
  templateId
) {
  return notion(
    accessToken,
    `/blocks/${templateId}/children`,
    {
      method: "PATCH",

      body: JSON.stringify({
        children: [
          {
            object: "block",

            type: "paragraph",

            paragraph: {
              rich_text: [
                {
                  type: "text",

                  text: {
                    content:
                      TEMP_MARKER,
                  },
                },
              ],
            },
          },
        ],
      }),
    }
  );
}

async function deleteBlock(
  accessToken,
  blockId
) {
  return notion(
    accessToken,
    `/blocks/${blockId}`,
    {
      method: "DELETE",
    }
  );
}

async function waitForMarkerState(
  accessToken,
  templateId,
  shouldExist
) {
  const polling = [];

  for (
    let attempt = 1;
    attempt <= MAX_POLL_ATTEMPTS;
    attempt += 1
  ) {
    const blocks =
      await listAllBlockChildren(
        accessToken,
        templateId
      );

    const markerBlocks =
      findBlocksByExactText(
        blocks,
        TEMP_MARKER
      );

    const exists =
      markerBlocks.length > 0;

    polling.push({
      attempt,

      marker_count:
        markerBlocks.length,

      expected_exists:
        shouldExist,

      observed_exists:
        exists,
    });

    if (exists === shouldExist) {
      return {
        matched: true,

        attempts:
          attempt,

        blocks,

        markerBlocks,

        polling,
      };
    }

    if (
      attempt <
      MAX_POLL_ATTEMPTS
    ) {
      await sleep(
        POLL_INTERVAL_MS
      );
    }
  }

  const finalBlocks =
    await listAllBlockChildren(
      accessToken,
      templateId
    );

  const finalMarkerBlocks =
    findBlocksByExactText(
      finalBlocks,
      TEMP_MARKER
    );

  return {
    matched: false,

    attempts:
      MAX_POLL_ATTEMPTS,

    blocks:
      finalBlocks,

    markerBlocks:
      finalMarkerBlocks,

    polling,
  };
}

export default async function handler(
  req,
  res
) {
  let accessToken = null;
  let labTemplateId = null;
  let temporaryMarkerBlockId = null;

  let restorationAttempted = false;
  let restorationSucceeded = false;
  let restorationError = null;

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
      sourceTemplate,
    } = await getContext(req);

    accessToken =
      connection.access_token;

    /*
      1. Détecter le template laboratoire.
    */
    const templates =
      await listAllTemplates(
        accessToken,
        sourceTemplate
          .notion_data_source_id
      );

    const labMatches =
      findLabTemplates(
        templates
      );

    if (labMatches.length === 0) {
      const error = new Error(
        "Le template laboratoire " +
        `« ${LAB_TEMPLATE_NAME} » ` +
        "est introuvable dans la data source Classes."
      );

      error.statusCode = 404;

      throw error;
    }

    if (labMatches.length > 1) {
      const error = new Error(
        "Plusieurs templates laboratoire " +
        "portent exactement le même nom. " +
        "Le test est refusé par sécurité."
      );

      error.statusCode = 409;

      throw error;
    }

    const labTemplate =
      labMatches[0];

    labTemplateId =
      labTemplate.id;

    if (!labTemplateId) {
      throw new Error(
        "Le template laboratoire détecté " +
        "ne possède aucun ID exploitable."
      );
    }

    /*
      2. Vérifier qu'il est lisible
      comme page.
    */
    const labTemplatePage =
      await notion(
        accessToken,
        `/pages/${labTemplateId}`,
        {
          method: "GET",
        }
      );

    /*
      3. Lire son état initial.
    */
    const initialBlocks =
      await listAllBlockChildren(
        accessToken,
        labTemplateId
      );

    const initialTextBlocks =
      findBlocksByExactText(
        initialBlocks,
        INITIAL_TEXT
      );

    const preexistingMarkers =
      findBlocksByExactText(
        initialBlocks,
        TEMP_MARKER
      );

    if (
      initialTextBlocks.length === 0
    ) {
      const error = new Error(
        "Le texte initial attendu est absent : " +
        `« ${INITIAL_TEXT} ». ` +
        "Le test est refusé pour éviter une " +
        "mauvaise cible."
      );

      error.statusCode = 409;

      throw error;
    }

    if (
      preexistingMarkers.length > 0
    ) {
      const error = new Error(
        "Un marqueur temporaire existe déjà " +
        "dans le template laboratoire. " +
        "Supprimez-le avant de relancer le test."
      );

      error.statusCode = 409;

      throw error;
    }

    /*
      4. TEST D'ÉCRITURE RÉEL :
      ajouter un paragraphe directement
      au template.
    */
    const appendResult =
      await appendTemporaryMarker(
        accessToken,
        labTemplateId
      );

    /*
      L'API renvoie normalement les blocs
      créés dans results.
    */
    temporaryMarkerBlockId =
      appendResult?.results?.[0]?.id ||
      null;

    /*
      5. Vérifier que le marqueur apparaît
      réellement dans le template.
    */
    const appearance =
      await waitForMarkerState(
        accessToken,
        labTemplateId,
        true
      );

    if (!appearance.matched) {
      const error = new Error(
        "La requête d'écriture a été acceptée, " +
        "mais le marqueur temporaire n'est pas " +
        "apparu dans le template."
      );

      error.statusCode = 502;

      throw error;
    }

    /*
      Si l'ID n'était pas présent dans
      la réponse d'ajout, on le récupère
      depuis la lecture vérifiée.
    */
    if (!temporaryMarkerBlockId) {
      temporaryMarkerBlockId =
        appearance
          .markerBlocks?.[0]?.id ||
        null;
    }

    if (!temporaryMarkerBlockId) {
      const error = new Error(
        "Le marqueur est visible mais son ID " +
        "n'a pas pu être déterminé pour restauration."
      );

      error.statusCode = 500;

      throw error;
    }

    /*
      6. RESTAURATION :
      supprimer uniquement le bloc
      ajouté par ce test.
    */
    restorationAttempted = true;

    await deleteBlock(
      accessToken,
      temporaryMarkerBlockId
    );

    /*
      On neutralise l'ID immédiatement :
      le finally ne doit pas tenter
      une seconde suppression.
    */
    temporaryMarkerBlockId = null;

    /*
      7. Vérifier la disparition réelle.
    */
    const disappearance =
      await waitForMarkerState(
        accessToken,
        labTemplateId,
        false
      );

    if (!disappearance.matched) {
      restorationError =
        "Le marqueur temporaire reste visible " +
        "après la tentative de suppression.";

      throw new Error(
        restorationError
      );
    }

    /*
      8. Vérifier que l'état initial
      essentiel subsiste.
    */
    const finalBlocks =
      disappearance.blocks;

    const finalInitialTextBlocks =
      findBlocksByExactText(
        finalBlocks,
        INITIAL_TEXT
      );

    const initialStatePreserved =
      finalInitialTextBlocks.length > 0;

    if (!initialStatePreserved) {
      restorationError =
        "Le texte initial n'est plus présent " +
        "après restauration.";

      throw new Error(
        restorationError
      );
    }

    restorationSucceeded = true;

    /*
      9. Conclusion :
      la mise à jour directe d'un template
      existant est prouvée uniquement si :
      - ajout réel observé ;
      - suppression réelle observée ;
      - état initial préservé.
    */
    return res
      .status(200)
      .json({
        ok: true,

        message:
          "Test réversible de mise à jour " +
          "d'un template existant terminé.",

        notion_api_version:
          NOTION_VERSION,

        workspace: {
          id:
            connection.workspace_id,

          name:
            connection.workspace_name ||
            null,
        },

        laboratory_template: {
          name:
            labTemplate.name,

          template_id:
            labTemplateId,

          data_source_id:
            sourceTemplate
              .notion_data_source_id,

          page_readable:
            Boolean(
              labTemplatePage?.id
            ),
        },

        initial_state: {
          expected_text:
            INITIAL_TEXT,

          expected_text_found:
            initialTextBlocks.length > 0,

          expected_text_match_count:
            initialTextBlocks.length,

          preexisting_marker_count:
            preexistingMarkers.length,
        },

        write_test: {
          marker:
            TEMP_MARKER,

          append_request_accepted:
            true,

          marker_observed:
            appearance.matched,

          marker_match_count:
            appearance
              .markerBlocks.length,

          polling:
            appearance.polling,
        },

        restoration: {
          attempted:
            restorationAttempted,

          marker_deleted:
            true,

          marker_absent_after_delete:
            disappearance.matched,

          initial_text_preserved:
            initialStatePreserved,

          succeeded:
            restorationSucceeded,

          error:
            restorationError,

          polling:
            disappearance.polling,
        },

        capability: {
          update_existing_template_object:
            (
              appearance.matched &&
              disappearance.matched &&
              initialStatePreserved
            )
              ? "supported"
              : "inconclusive",

          proven:
            Boolean(
              appearance.matched &&
              disappearance.matched &&
              initialStatePreserved
            ),

          append_block_to_template:
            appearance.matched,

          delete_block_from_template:
            disappearance.matched,

          preserve_initial_state:
            initialStatePreserved,
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

          temporary_marker_remaining:
            false,
        },
      });
  } catch (error) {
    console.error(
      "Erreur test mise à jour template :",
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

        restoration: {
          attempted:
            restorationAttempted,

          succeeded:
            restorationSucceeded,

          error:
            restorationError,
        },
      });
  } finally {
    /*
      Filet de sécurité.

      Si une erreur survient après création
      du marqueur mais avant restauration,
      on tente de supprimer uniquement
      ce bloc temporaire.
    */
    if (
      accessToken &&
      temporaryMarkerBlockId
    ) {
      try {
        restorationAttempted = true;

        await deleteBlock(
          accessToken,
          temporaryMarkerBlockId
        );
      } catch (error) {
        console.error(
          "Échec restauration de secours " +
          "du template laboratoire :",
          error
        );
      }
    }
  }
}
