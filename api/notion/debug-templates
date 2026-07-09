import { neon } from "@neondatabase/serverless";

const NOTION_VERSION =
  "2026-03-11";

/*
  Diagnostic lecture seule des templates
  de Mi Espacio Docente.

  Cet endpoint :
  - récupère le workspace connecté ;
  - charge les composants déjà enregistrés
    par setup.js dans Neon ;
  - récupère chaque database moderne ;
  - découvre ses data sources ;
  - liste tous les templates accessibles ;
  - gère la pagination ;
  - ne modifie rien dans Notion ;
  - ne modifie rien dans Neon.

  Objectif :
  préparer le registre officiel versionné
  et le futur moteur de mises à jour.
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

  const componentRows = await sql`
    SELECT
      component_key,
      notion_object_id,
      notion_object_type,
      notion_title
    FROM notion_workspace_components
    WHERE workspace_id = ${workspaceId}
    ORDER BY component_key ASC
  `;

  if (componentRows.length === 0) {
    const error = new Error(
      "Aucun composant Mi Espacio Docente " +
      "n'est enregistré pour ce workspace. " +
      "Lancez d'abord /api/notion/setup."
    );

    error.statusCode = 409;

    throw error;
  }

  return {
    connection,
    components:
      componentRows,
  };
}

async function retrieveDatabase(
  accessToken,
  databaseId
) {
  return notion(
    accessToken,
    `/databases/${databaseId}`,
    {
      method: "GET",
    }
  );
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

function serializeTemplate(
  template
) {
  return {
    id:
      template?.id || null,

    name:
      template?.name || null,

    is_default:
      Boolean(
        template?.is_default
      ),
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
      components,
    } = await getContext(req);

    const accessToken =
      connection.access_token;

    const databases = {};

    const allTemplates = [];

    const failures = [];

    /*
      On parcourt les composants enregistrés
      par setup.js.

      Pour l'instant, setup.js enregistre
      les 33 bases avec le type "database".
    */
    for (const component of components) {
      const componentKey =
        component.component_key;

      const databaseId =
        component.notion_object_id;

      try {
        /*
          API moderne :
          récupérer le conteneur database
          afin d'obtenir data_sources.
        */
        const database =
          await retrieveDatabase(
            accessToken,
            databaseId
          );

        const dataSources =
          Array.isArray(
            database?.data_sources
          )
            ? database.data_sources
            : [];

        const serializedDataSources = [];

        for (
          const dataSource
          of dataSources
        ) {
          const dataSourceId =
            dataSource?.id;

          if (!dataSourceId) {
            continue;
          }

          try {
            const templates =
              await listAllTemplates(
                accessToken,
                dataSourceId
              );

            const serializedTemplates =
              templates.map(
                serializeTemplate
              );

            serializedDataSources.push({
              id:
                dataSourceId,

              name:
                dataSource?.name ||
                null,

              template_count:
                serializedTemplates.length,

              templates:
                serializedTemplates,
            });

            for (
              const template
              of serializedTemplates
            ) {
              allTemplates.push({
                component_key:
                  componentKey,

                database_id:
                  databaseId,

                database_title:
                  component.notion_title ||
                  null,

                data_source_id:
                  dataSourceId,

                data_source_name:
                  dataSource?.name ||
                  null,

                template_id:
                  template.id,

                template_name:
                  template.name,

                is_default:
                  template.is_default,
              });
            }
          } catch (error) {
            failures.push({
              stage:
                "list_templates",

              component_key:
                componentKey,

              database_id:
                databaseId,

              data_source_id:
                dataSourceId,

              error:
                error.message,
            });

            serializedDataSources.push({
              id:
                dataSourceId,

              name:
                dataSource?.name ||
                null,

              template_count:
                null,

              templates:
                [],

              error:
                error.message,
            });
          }
        }

        databases[componentKey] = {
          database_id:
            databaseId,

          database_title:
            component.notion_title ||
            null,

          data_source_count:
            serializedDataSources.length,

          data_sources:
            serializedDataSources,
        };
      } catch (error) {
        failures.push({
          stage:
            "retrieve_database",

          component_key:
            componentKey,

          database_id:
            databaseId,

          error:
            error.message,
        });

        databases[componentKey] = {
          database_id:
            databaseId,

          database_title:
            component.notion_title ||
            null,

          data_source_count:
            null,

          data_sources:
            [],

          error:
            error.message,
        };
      }
    }

    const componentsWithTemplates =
      Object.values(databases)
        .filter(
          (database) =>
            (database.data_sources || [])
              .some(
                (dataSource) =>
                  (
                    dataSource
                      .template_count || 0
                  ) > 0
              )
        )
        .length;

    const dataSourceCount =
      Object.values(databases)
        .reduce(
          (
            total,
            database
          ) =>
            total +
            (
              database
                .data_sources
                ?.length || 0
            ),
          0
        );

    return res
      .status(200)
      .json({
        ok:
          failures.length === 0,

        message:
          failures.length === 0
            ? (
                "Diagnostic des templates " +
                "Notion réussi."
              )
            : (
                "Diagnostic terminé avec " +
                "certaines erreurs partielles."
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

        summary: {
          registered_components:
            components.length,

          scanned_databases:
            Object.keys(
              databases
            ).length,

          discovered_data_sources:
            dataSourceCount,

          components_with_templates:
            componentsWithTemplates,

          discovered_templates:
            allTemplates.length,

          failure_count:
            failures.length,
        },

        templates:
          allTemplates,

        databases,

        failures,

        read_only:
          true,
      });
  } catch (error) {
    console.error(
      "Erreur diagnostic templates :",
      error
    );

    const statusCode =
      error.statusCode || 500;

    return res
      .status(statusCode)
      .json({
        ok: false,

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
