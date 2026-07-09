import { neon } from "@neondatabase/serverless";

import {
  MI_ESPACIO_DOCENTE_SCHEMA,
  MI_ESPACIO_DOCENTE_SCHEMA_VERSION,
} from "../../lib/mi-espacio-docente-schema.js";

const NOTION_VERSION = "2022-06-28";

/*
  Installation et validation complète
  de Mi Espacio Docente.

  Cet endpoint :
  - charge le schéma officiel versionné ;
  - cherche les 33 bases attendues ;
  - normalise les titres avant comparaison ;
  - vérifie toutes les propriétés obligatoires ;
  - vérifie le type exact de chaque propriété ;
  - refuse les bases absentes ;
  - refuse les doublons ambigus ;
  - refuse les structures invalides ;
  - autorise les propriétés supplémentaires ;
  - enregistre les 33 IDs propres au workspace ;
  - maintient notion_workspace_config
    pour la compatibilité avec faire-appel.js.

  Aucun ID Notion n'est codé en dur.
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

function getPlainText(items = []) {
  return items
    .map(
      (item) =>
        item?.plain_text || ""
    )
    .join("")
    .trim();
}

function getDatabaseTitle(database) {
  return (
    getPlainText(
      database?.title || []
    ) ||
    "(Sans titre)"
  );
}

/*
  Protège la détection contre :
  - espaces insécables ;
  - caractères invisibles ;
  - variantes Unicode équivalentes ;
  - espaces multiples.
*/
function normalizeDatabaseTitle(value) {
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

async function getConnection(req) {
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
      "Aucun espace Notion connecté pour cette session."
    );

    error.statusCode = 401;

    throw error;
  }

  const sql = neon(databaseUrl);

  const rows = await sql`
    SELECT
      workspace_id,
      workspace_name,
      access_token
    FROM notion_connections
    WHERE workspace_id = ${workspaceId}
    LIMIT 1
  `;

  const connection = rows[0];

  if (
    !connection ||
    !connection.access_token
  ) {
    const error = new Error(
      "Connexion Notion introuvable ou expirée."
    );

    error.statusCode = 401;

    throw error;
  }

  return {
    sql,
    connection,
  };
}

async function searchAllDatabases(
  accessToken
) {
  const databases = [];

  let startCursor;
  let hasMore = true;

  while (hasMore) {
    const body = {
      filter: {
        property: "object",
        value: "database",
      },

      page_size: 100,
    };

    if (startCursor) {
      body.start_cursor =
        startCursor;
    }

    const result = await notion(
      accessToken,
      "/search",
      {
        method: "POST",

        body: JSON.stringify(body),
      }
    );

    databases.push(
      ...(result.results || [])
    );

    hasMore =
      Boolean(result.has_more);

    startCursor =
      result.next_cursor ||
      undefined;
  }

  return databases;
}

/*
  Validation stricte du contrat officiel.

  Les propriétés supplémentaires sont
  autorisées et ne bloquent pas
  l'installation.
*/
function validateDatabase(
  database,
  requiredProperties = {}
) {
  const actualProperties =
    database?.properties || {};

  const missing = [];
  const wrongTypes = [];

  for (
    const [propertyName, expectedType]
    of Object.entries(
      requiredProperties
    )
  ) {
    const actualProperty =
      actualProperties[propertyName];

    if (!actualProperty) {
      missing.push({
        property:
          propertyName,

        expected_type:
          expectedType,
      });

      continue;
    }

    const actualType =
      actualProperty.type || null;

    if (actualType !== expectedType) {
      wrongTypes.push({
        property:
          propertyName,

        expected:
          expectedType,

        actual:
          actualType,
      });
    }
  }

  const requiredPropertyNames =
    new Set(
      Object.keys(
        requiredProperties
      )
    );

  const extraProperties =
    Object.entries(actualProperties)
      .filter(
        ([propertyName]) =>
          !requiredPropertyNames.has(
            propertyName
          )
      )
      .map(
        ([propertyName, property]) => ({
          property:
            propertyName,

          type:
            property?.type || null,
        })
      );

  return {
    valid:
      missing.length === 0 &&
      wrongTypes.length === 0,

    missing,

    wrongTypes,

    /*
      Informatif uniquement.
      Ne bloque jamais l'installation.
    */
    extraProperties,
  };
}

function findDatabase(
  databases,
  definition
) {
  const normalizedExpectedTitle =
    normalizeDatabaseTitle(
      definition.title
    );

  const titleMatches =
    databases.filter(
      (database) =>
        normalizeDatabaseTitle(
          getDatabaseTitle(database)
        ) === normalizedExpectedTitle
    );

  const evaluated =
    titleMatches.map(
      (database) => ({
        database,

        validation:
          validateDatabase(
            database,
            definition.requiredProperties ||
              {}
          ),
      })
    );

  const validMatches =
    evaluated.filter(
      (item) =>
        item.validation.valid
    );

  /*
    Une seule base :
    titre correct + structure correcte.
  */
  if (validMatches.length === 1) {
    return {
      status: "found",

      database:
        validMatches[0].database,

      validation:
        validMatches[0].validation,
    };
  }

  /*
    Plusieurs bases entièrement valides :
    impossible de savoir laquelle utiliser.
  */
  if (validMatches.length > 1) {
    return {
      status: "ambiguous",

      database: null,

      candidates:
        validMatches.map(
          (item) => ({
            id:
              item.database.id,

            title:
              getDatabaseTitle(
                item.database
              ),

            url:
              item.database.url || null,

            validation:
              item.validation,
          })
        ),
    };
  }

  /*
    Le titre existe, mais aucune base
    correspondante n'a une structure valide.
  */
  if (titleMatches.length > 0) {
    return {
      status: "invalid_structure",

      database: null,

      candidates:
        evaluated.map(
          (item) => ({
            id:
              item.database.id,

            title:
              getDatabaseTitle(
                item.database
              ),

            url:
              item.database.url || null,

            validation:
              item.validation,
          })
        ),
    };
  }

  return {
    status: "not_found",

    database: null,

    candidates: [],
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
      sql,
      connection,
    } = await getConnection(req);

    const databases =
      await searchAllDatabases(
        connection.access_token
      );

    const schemaEntries =
      Object.entries(
        MI_ESPACIO_DOCENTE_SCHEMA
      );

    const detection = {};

    /*
      Validation des 33 composants
      directement avec le schéma 1.0.0.
    */
    for (
      const [componentKey, definition]
      of schemaEntries
    ) {
      detection[componentKey] =
        findDatabase(
          databases,
          definition
        );
    }

    const failures =
      Object.entries(detection)
        .filter(
          ([, result]) =>
            result.status !== "found"
        )
        .map(
          ([componentKey, result]) => ({
            component_key:
              componentKey,

            expected_title:
              MI_ESPACIO_DOCENTE_SCHEMA[
                componentKey
              ].title,

            status:
              result.status,

            candidates:
              result.candidates || [],
          })
        );

    /*
      Aucune écriture Neon si une seule
      base échoue à la validation.
    */
    if (failures.length > 0) {
      const statusCounts = {
        not_found: 0,
        ambiguous: 0,
        invalid_structure: 0,
      };

      for (const failure of failures) {
        if (
          Object.prototype.hasOwnProperty.call(
            statusCounts,
            failure.status
          )
        ) {
          statusCounts[
            failure.status
          ] += 1;
        }
      }

      return res
        .status(422)
        .json({
          ok: false,

          error:
            "Installation automatique impossible : " +
            "le template Notion ne respecte pas " +
            "le schéma officiel de " +
            "Mi Espacio Docente.",

          schema_version:
            MI_ESPACIO_DOCENTE_SCHEMA_VERSION,

          diagnostic: {
            workspace_id:
              connection.workspace_id,

            workspace_name:
              connection.workspace_name ||
              null,

            accessible_database_count:
              databases.length,

            expected_database_count:
              schemaEntries.length,

            detected_database_count:
              Object.values(detection)
                .filter(
                  (result) =>
                    result.status ===
                    "found"
                )
                .length,

            failure_count:
              failures.length,

            not_found_count:
              statusCounts.not_found,

            ambiguous_count:
              statusCounts.ambiguous,

            invalid_structure_count:
              statusCounts.invalid_structure,
          },

          failures,
        });
    }

    /*
      À ce stade :
      les 33 bases existent,
      sont non ambiguës,
      et respectent toutes le schéma.
    */

    for (
      const [componentKey, result]
      of Object.entries(detection)
    ) {
      const database =
        result.database;

      const title =
        getDatabaseTitle(database);

      await sql`
        INSERT INTO notion_workspace_components (
          workspace_id,
          component_key,
          notion_object_id,
          notion_object_type,
          notion_title,
          updated_at
        )
        VALUES (
          ${connection.workspace_id},
          ${componentKey},
          ${database.id},
          ${"database"},
          ${title},
          NOW()
        )
        ON CONFLICT (
          workspace_id,
          component_key
        )
        DO UPDATE SET
          notion_object_id =
            EXCLUDED.notion_object_id,
          notion_object_type =
            EXCLUDED.notion_object_type,
          notion_title =
            EXCLUDED.notion_title,
          updated_at = NOW()
      `;
    }

    /*
      Compatibilité avec faire-appel.js.

      On continue temporairement à remplir
      notion_workspace_config.
    */
    const occurrencesDb =
      detection.occurrences.database;

    const inscriptionsDb =
      detection.inscriptions.database;

    const presencesDb =
      detection.presences.database;

    const feuillesAppelDb =
      detection.feuilles_appel.database;

    await sql`
      INSERT INTO notion_workspace_config (
        workspace_id,
        occurrences_db_id,
        inscriptions_db_id,
        presences_db_id,
        feuilles_appel_db_id,
        updated_at
      )
      VALUES (
        ${connection.workspace_id},
        ${occurrencesDb.id},
        ${inscriptionsDb.id},
        ${presencesDb.id},
        ${feuillesAppelDb.id},
        NOW()
      )
      ON CONFLICT (workspace_id)
      DO UPDATE SET
        occurrences_db_id =
          EXCLUDED.occurrences_db_id,
        inscriptions_db_id =
          EXCLUDED.inscriptions_db_id,
        presences_db_id =
          EXCLUDED.presences_db_id,
        feuilles_appel_db_id =
          EXCLUDED.feuilles_appel_db_id,
        updated_at = NOW()
    `;

    const detected = {};

    let extraPropertyCount = 0;

    for (
      const [componentKey, result]
      of Object.entries(detection)
    ) {
      const extras =
        result.validation
          ?.extraProperties || [];

      extraPropertyCount +=
        extras.length;

      detected[componentKey] = {
        id:
          result.database.id,

        title:
          getDatabaseTitle(
            result.database
          ),

        required_property_count:
          Object.keys(
            MI_ESPACIO_DOCENTE_SCHEMA[
              componentKey
            ].requiredProperties || {}
          ).length,

        extra_property_count:
          extras.length,
      };
    }

    return res
      .status(200)
      .json({
        ok: true,

        message:
          "Installation complète et validation " +
          "structurelle de Mi Espacio Docente réussies.",

        schema_version:
          MI_ESPACIO_DOCENTE_SCHEMA_VERSION,

        workspace: {
          id:
            connection.workspace_id,

          name:
            connection.workspace_name ||
            null,
        },

        summary: {
          expected:
            schemaEntries.length,

          detected:
            Object.keys(
              detected
            ).length,

          structurally_valid:
            Object.keys(
              detected
            ).length,

          saved_components:
            Object.keys(
              detected
            ).length,

          extra_properties_allowed:
            extraPropertyCount,

          legacy_config_updated:
            true,
        },

        detected,

        saved_to_neon:
          true,
      });
  } catch (error) {
    console.error(
      "Erreur installation Notion :",
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
