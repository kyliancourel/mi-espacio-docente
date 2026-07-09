import { neon } from "@neondatabase/serverless";

import {
  MI_ESPACIO_DOCENTE_SCHEMA,
  MI_ESPACIO_DOCENTE_SCHEMA_VERSION,
} from "../../lib/mi-espacio-docente-schema.js";

import {
  MI_ESPACIO_DOCENTE_TEMPLATES,
  MI_ESPACIO_DOCENTE_TEMPLATES_VERSION,
} from "../../lib/mi-espacio-docente-templates.js";

const NOTION_LEGACY_VERSION =
  "2022-06-28";

const NOTION_MODERN_VERSION =
  "2026-03-11";

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

  Templates :
  - charge le registre officiel versionné ;
  - découvre les data sources modernes ;
  - liste les templates de chaque base concernée ;
  - identifie les templates officiels par :
      componentKey + nom exact normalisé ;
  - refuse un template officiel absent ;
  - refuse un template officiel ambigu ;
  - enregistre les IDs propres au workspace ;
  - conserve les champs prévus pour
    les futures empreintes et mises à jour ;
  - renseigne automatiquement
    feuille_template_id ;

  Compatibilité :
  - maintient notion_workspace_config
    pour faire-appel.js.

  Important :
  - aucun ID Notion n'est codé en dur ;
  - aucune création de template ici ;
  - aucune mise à jour de contenu ici ;
  - la propagation réelle sera gérée
    par le futur moteur update.js après
    validation des capacités d'écriture API.
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
  Normalisation commune pour :
  - titres de bases ;
  - noms de templates.

  Protège contre :
  - espaces insécables ;
  - caractères invisibles ;
  - variantes Unicode équivalentes ;
  - espaces multiples.
*/
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

function normalizeDatabaseTitle(value) {
  return normalizeText(value);
}

function normalizeTemplateName(value) {
  return normalizeText(value);
}

/*
  Appel API Notion générique avec
  version explicite.

  Cela permet de conserver :
  - 2022-06-28 pour le moteur historique ;
  - 2026-03-11 pour data sources/templates.
*/
async function notionWithVersion(
  accessToken,
  notionVersion,
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
        notionVersion,

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

async function notionLegacy(
  accessToken,
  path,
  options = {}
) {
  return notionWithVersion(
    accessToken,
    NOTION_LEGACY_VERSION,
    path,
    options
  );
}

async function notionModern(
  accessToken,
  path,
  options = {}
) {
  return notionWithVersion(
    accessToken,
    NOTION_MODERN_VERSION,
    path,
    options
  );
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

    const result = await notionLegacy(
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
      status:
        "invalid_structure",

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

/*
  API moderne :
  récupérer le conteneur database
  pour découvrir ses data_sources.
*/
async function retrieveModernDatabase(
  accessToken,
  databaseId
) {
  return notionModern(
    accessToken,
    `/databases/${databaseId}`,
    {
      method: "GET",
    }
  );
}

/*
  Liste paginée de tous les templates
  d'une data source.
*/
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

    const result = await notionModern(
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

/*
  Charge tous les templates accessibles
  pour un composant officiel donné.

  Une database moderne peut théoriquement
  exposer plusieurs data sources.
*/
async function discoverComponentTemplates(
  accessToken,
  componentKey,
  database
) {
  const modernDatabase =
    await retrieveModernDatabase(
      accessToken,
      database.id
    );

  const dataSources =
    Array.isArray(
      modernDatabase?.data_sources
    )
      ? modernDatabase.data_sources
      : [];

  const discovered = [];

  for (const dataSource of dataSources) {
    const dataSourceId =
      dataSource?.id;

    if (!dataSourceId) {
      continue;
    }

    const templates =
      await listAllTemplates(
        accessToken,
        dataSourceId
      );

    for (const template of templates) {
      discovered.push({
        component_key:
          componentKey,

        database_id:
          database.id,

        data_source_id:
          dataSourceId,

        data_source_name:
          dataSource?.name || null,

        template_id:
          template?.id || null,

        template_name:
          template?.name || null,

        is_default:
          Boolean(
            template?.is_default
          ),
      });
    }
  }

  return {
    modernDatabase,
    dataSources,
    templates:
      discovered,
  };
}

/*
  Détection stricte d'un template officiel.

  Identité fonctionnelle :
  - componentKey ;
  - nom exact après normalisation.

  Aucun ID maître n'est utilisé.
*/
function findOfficialTemplate(
  discoveredTemplates,
  definition
) {
  const normalizedExpectedName =
    normalizeTemplateName(
      definition.name
    );

  const matches =
    discoveredTemplates.filter(
      (template) =>
        normalizeTemplateName(
          template.template_name
        ) === normalizedExpectedName
    );

  if (matches.length === 1) {
    return {
      status: "found",

      template:
        matches[0],
    };
  }

  if (matches.length > 1) {
    return {
      status: "ambiguous",

      template: null,

      candidates:
        matches,
    };
  }

  return {
    status: "not_found",

    template: null,

    candidates: [],
  };
}

/*
  Détecte les templates officiels
  définis dans le registre versionné.

  On ne scanne ici que les composants
  réellement nécessaires au registre.
*/
async function detectOfficialTemplates(
  accessToken,
  detection
) {
  const templateEntries =
    Object.entries(
      MI_ESPACIO_DOCENTE_TEMPLATES
    );

  const componentKeys =
    [
      ...new Set(
        templateEntries.map(
          ([, definition]) =>
            definition.componentKey
        )
      ),
    ];

  const discoveredByComponent = {};
  const componentDiagnostics = {};

  for (
    const componentKey
    of componentKeys
  ) {
    const database =
      detection[componentKey]
        ?.database;

    if (!database) {
      componentDiagnostics[
        componentKey
      ] = {
        status:
          "database_not_available",

        database_id:
          null,

        data_source_count:
          0,

        discovered_template_count:
          0,
      };

      discoveredByComponent[
        componentKey
      ] = [];

      continue;
    }

    const discovery =
      await discoverComponentTemplates(
        accessToken,
        componentKey,
        database
      );

    discoveredByComponent[
      componentKey
    ] = discovery.templates;

    componentDiagnostics[
      componentKey
    ] = {
      status:
        "scanned",

      database_id:
        database.id,

      data_source_count:
        discovery.dataSources.length,

      discovered_template_count:
        discovery.templates.length,
    };
  }

  const templateDetection = {};

  for (
    const [templateKey, definition]
    of templateEntries
  ) {
    const componentKey =
      definition.componentKey;

    const discoveredTemplates =
      discoveredByComponent[
        componentKey
      ] || [];

    templateDetection[
      templateKey
    ] = {
      ...findOfficialTemplate(
        discoveredTemplates,
        definition
      ),

      definition,
    };
  }

  return {
    templateDetection,
    discoveredByComponent,
    componentDiagnostics,
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

    const accessToken =
      connection.access_token;

    /*
      ==================================================
      PHASE 1
      Validation des 33 bases officielles
      ==================================================
    */

    const databases =
      await searchAllDatabases(
        accessToken
      );

    const schemaEntries =
      Object.entries(
        MI_ESPACIO_DOCENTE_SCHEMA
      );

    const detection = {};

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

          templates_version:
            MI_ESPACIO_DOCENTE_TEMPLATES_VERSION,

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
      - 33 bases présentes ;
      - aucune ambiguïté ;
      - structures conformes.
    */

    /*
      ==================================================
      PHASE 2
      Détection des templates officiels
      ==================================================
    */

    const {
      templateDetection,
      componentDiagnostics,
    } = await detectOfficialTemplates(
      accessToken,
      detection
    );

    const templateFailures =
      Object.entries(
        templateDetection
      )
        .filter(
          ([, result]) =>
            result.status !== "found"
        )
        .map(
          ([templateKey, result]) => ({
            template_key:
              templateKey,

            component_key:
              result.definition
                .componentKey,

            expected_name:
              result.definition.name,

            expected_version:
              result.definition.version,

            status:
              result.status,

            candidates:
              result.candidates || [],
          })
        );

    /*
      Important :
      aucune écriture Neon si un template
      officiel requis est absent ou ambigu.

      Pour l'instant setup.js est strict
      pour une installation nouvelle.

      Le futur update.js gérera les états :
      - missing ;
      - outdated ;
      - locally_modified ;
      - conflict.
    */
    if (templateFailures.length > 0) {
      const templateStatusCounts = {
        not_found: 0,
        ambiguous: 0,
      };

      for (
        const failure
        of templateFailures
      ) {
        if (
          Object.prototype.hasOwnProperty.call(
            templateStatusCounts,
            failure.status
          )
        ) {
          templateStatusCounts[
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
            "un ou plusieurs templates officiels " +
            "de Mi Espacio Docente sont absents " +
            "ou ambigus.",

          schema_version:
            MI_ESPACIO_DOCENTE_SCHEMA_VERSION,

          templates_version:
            MI_ESPACIO_DOCENTE_TEMPLATES_VERSION,

          workspace: {
            id:
              connection.workspace_id,

            name:
              connection.workspace_name ||
              null,
          },

          database_validation: {
            expected:
              schemaEntries.length,

            detected:
              schemaEntries.length,

            structurally_valid:
              schemaEntries.length,
          },

          template_diagnostic: {
            expected_template_count:
              Object.keys(
                MI_ESPACIO_DOCENTE_TEMPLATES
              ).length,

            detected_template_count:
              Object.values(
                templateDetection
              )
                .filter(
                  (result) =>
                    result.status ===
                    "found"
                )
                .length,

            failure_count:
              templateFailures.length,

            not_found_count:
              templateStatusCounts
                .not_found,

            ambiguous_count:
              templateStatusCounts
                .ambiguous,
          },

          component_diagnostics:
            componentDiagnostics,

          failures:
            templateFailures,

          saved_to_neon:
            false,
        });
    }

    /*
      À ce stade :
      - 33 bases conformes ;
      - 5 templates officiels détectés ;
      - aucune ambiguïté.
    */

    /*
      ==================================================
      PHASE 3
      Enregistrement des 33 composants
      ==================================================
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
      ==================================================
      PHASE 4
      Enregistrement des templates officiels
      ==================================================

      Règle importante :
      - première installation :
          installed_version = version officielle
          sync_status = current

      - relance ultérieure :
          on met à jour les métadonnées Notion
          et la version officielle ;

          on ne réinitialise pas aveuglément
          un éventuel état :
          locally_modified / conflict / outdated.

      Cela prépare le futur update.js.
    */

    for (
      const [templateKey, result]
      of Object.entries(
        templateDetection
      )
    ) {
      const definition =
        result.definition;

      const template =
        result.template;

      await sql`
        INSERT INTO notion_workspace_templates (
          workspace_id,
          template_key,
          component_key,
          notion_template_id,
          notion_data_source_id,
          notion_template_name,
          official_version,
          installed_version,
          official_fingerprint,
          local_fingerprint,
          sync_status,
          is_default,
          locally_modified,
          conflict_detected,
          last_detected_at,
          last_synced_at,
          created_at,
          updated_at
        )
        VALUES (
          ${connection.workspace_id},
          ${templateKey},
          ${definition.componentKey},
          ${template.template_id},
          ${template.data_source_id},
          ${template.template_name},
          ${definition.version},
          ${definition.version},
          ${null},
          ${null},
          ${"current"},
          ${template.is_default},
          ${false},
          ${false},
          NOW(),
          NOW(),
          NOW(),
          NOW()
        )
        ON CONFLICT (
          workspace_id,
          template_key
        )
        DO UPDATE SET
          component_key =
            EXCLUDED.component_key,

          notion_template_id =
            EXCLUDED.notion_template_id,

          notion_data_source_id =
            EXCLUDED.notion_data_source_id,

          notion_template_name =
            EXCLUDED.notion_template_name,

          official_version =
            EXCLUDED.official_version,

          is_default =
            EXCLUDED.is_default,

          last_detected_at =
            NOW(),

          updated_at =
            NOW(),

          installed_version =
            CASE
              WHEN
                notion_workspace_templates
                  .installed_version
                IS NULL
              THEN
                EXCLUDED.installed_version
              ELSE
                notion_workspace_templates
                  .installed_version
            END,

          sync_status =
            CASE
              WHEN
                notion_workspace_templates
                  .sync_status
                IN (
                  'locally_modified',
                  'conflict',
                  'outdated'
                )
              THEN
                notion_workspace_templates
                  .sync_status

              WHEN
                notion_workspace_templates
                  .installed_version
                IS DISTINCT FROM
                EXCLUDED.official_version
              THEN
                'outdated'

              ELSE
                'current'
            END,

          locally_modified =
            notion_workspace_templates
              .locally_modified,

          conflict_detected =
            notion_workspace_templates
              .conflict_detected,

          official_fingerprint =
            notion_workspace_templates
              .official_fingerprint,

          local_fingerprint =
            notion_workspace_templates
              .local_fingerprint,

          last_synced_at =
            notion_workspace_templates
              .last_synced_at
      `;
    }

    /*
      ==================================================
      PHASE 5
      Compatibilité faire-appel.js
      ==================================================
    */

    const occurrencesDb =
      detection.occurrences.database;

    const inscriptionsDb =
      detection.inscriptions.database;

    const presencesDb =
      detection.presences.database;

    const feuillesAppelDb =
      detection.feuilles_appel.database;

    const attendanceTemplate =
      templateDetection
        .attendance_sheet
        ?.template;

    if (
      !attendanceTemplate ||
      !attendanceTemplate.template_id
    ) {
      const error = new Error(
        "Le template officiel " +
        "« attendance_sheet » est introuvable " +
        "après validation."
      );

      error.statusCode = 500;

      throw error;
    }

    /*
      Désormais feuille_template_id
      est propre au workspace connecté.

      Plus aucun ID personnel n'est
      nécessaire dans faire-appel.js.
    */
    await sql`
      INSERT INTO notion_workspace_config (
        workspace_id,
        occurrences_db_id,
        inscriptions_db_id,
        presences_db_id,
        feuilles_appel_db_id,
        feuille_template_id,
        updated_at
      )
      VALUES (
        ${connection.workspace_id},
        ${occurrencesDb.id},
        ${inscriptionsDb.id},
        ${presencesDb.id},
        ${feuillesAppelDb.id},
        ${attendanceTemplate.template_id},
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

        feuille_template_id =
          EXCLUDED.feuille_template_id,

        updated_at =
          NOW()
    `;

    /*
      ==================================================
      PHASE 6
      Construction du diagnostic final
      ==================================================
    */

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

    const detectedTemplates = {};

    for (
      const [templateKey, result]
      of Object.entries(
        templateDetection
      )
    ) {
      const definition =
        result.definition;

      const template =
        result.template;

      detectedTemplates[
        templateKey
      ] = {
        component_key:
          definition.componentKey,

        name:
          template.template_name,

        notion_template_id:
          template.template_id,

        notion_data_source_id:
          template.data_source_id,

        official_version:
          definition.version,

        installed_version:
          definition.version,

        sync_status:
          "current",

        is_default:
          template.is_default,

        propagation_policy:
          definition.propagation ||
          null,

        local_changes_policy:
          definition.localChangesPolicy ||
          null,
      };
    }

    return res
      .status(200)
      .json({
        ok: true,

        message:
          "Installation complète, validation " +
          "structurelle et détection des templates " +
          "officiels de Mi Espacio Docente réussies.",

        schema_version:
          MI_ESPACIO_DOCENTE_SCHEMA_VERSION,

        templates_version:
          MI_ESPACIO_DOCENTE_TEMPLATES_VERSION,

        notion_api_versions: {
          databases:
            NOTION_LEGACY_VERSION,

          templates:
            NOTION_MODERN_VERSION,
        },

        workspace: {
          id:
            connection.workspace_id,

          name:
            connection.workspace_name ||
            null,
        },

        summary: {
          expected_databases:
            schemaEntries.length,

          detected_databases:
            Object.keys(
              detected
            ).length,

          structurally_valid_databases:
            Object.keys(
              detected
            ).length,

          saved_components:
            Object.keys(
              detected
            ).length,

          extra_properties_allowed:
            extraPropertyCount,

          expected_official_templates:
            Object.keys(
              MI_ESPACIO_DOCENTE_TEMPLATES
            ).length,

          detected_official_templates:
            Object.keys(
              detectedTemplates
            ).length,

          saved_official_templates:
            Object.keys(
              detectedTemplates
            ).length,

          attendance_template_configured:
            Boolean(
              attendanceTemplate
                .template_id
            ),

          legacy_config_updated:
            true,
        },

        detected,

        templates:
          detectedTemplates,

        template_component_diagnostics:
          componentDiagnostics,

        future_update_engine: {
          registry_ready:
            true,

          workspace_tracking_ready:
            true,

          version_tracking_ready:
            true,

          fingerprint_tracking_ready:
            false,

          creation_propagation_enabled:
            false,

          update_propagation_enabled:
            false,

          local_change_protection_ready:
            true,

          note:
            "La création et la mise à jour " +
            "automatiques des objets template " +
            "restent désactivées jusqu'à validation " +
            "du prototype réel d'écriture API.",
        },

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
