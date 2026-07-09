import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2022-06-28";

/*
  Générateur temporaire du schéma officiel
  de Mi Espacio Docente.

  Cet endpoint :
  - lit les 33 bases du workspace connecté ;
  - vérifie leur présence par titre exact ;
  - récupère toutes les propriétés réelles ;
  - génère un module JavaScript réutilisable ;
  - n'exporte aucun database_id ;
  - n'exporte aucune URL Notion ;
  - ne modifie rien dans Notion ;
  - ne modifie rien dans Neon.

  IMPORTANT :
  Une fois le fichier de schéma généré et copié,
  cet endpoint pourra être supprimé.
*/

const OFFICIAL_DATABASES = {
  annees_scolaires: {
    title: "📅 DB — Années scolaires",
  },

  classes: {
    title: "🎓 DB — Classes",
  },

  eleves: {
    title: "👨‍🎓 DB — Élèves",
  },

  besoins_particuliers: {
    title: "🧩 DB — Besoins particuliers",
  },

  adaptations: {
    title: "🧰 DB — Adaptations",
  },

  incidents: {
    title: "⚠️ DB — Incidents",
  },

  remediations: {
    title: "🛠️ DB — Remédiations",
  },

  journal_classe: {
    title: "📔 DB — Journal de classe",
  },

  devoirs: {
    title: "📝 DB — Devoirs",
  },

  sequences: {
    title: "📚 DB — Séquences",
  },

  seances: {
    title: "🧩 DB — Séances",
  },

  suivi_oral: {
    title: "🗣️ DB — Suivi oral",
  },

  evaluations: {
    title: "📝 DB — Évaluations",
  },

  resultats: {
    title: "📈 DB — Résultats",
  },

  competences: {
    title: "🎯 DB — Compétences",
  },

  maitrise_competences: {
    title: "📊 DB — Maîtrise des compétences",
  },

  ressources: {
    title: "📄 DB — Ressources",
  },

  observations_pedagogiques: {
    title: "📊 DB — Observations pédagogiques",
  },

  objectifs_individuels: {
    title: "🎯 DB — Objectifs individuels",
  },

  etablissements: {
    title: "🏫 DB — Établissements",
  },

  emploi_du_temps: {
    title: "🎓 DB — Emploi du temps",
  },

  rdv_parents: {
    title: "👪 DB — RDV Parents",
  },

  rdv_parents_profs: {
    title: "🏫 DB — RDV Parents-Profs",
  },

  sessions_parents_profs: {
    title: "📅 DB — Sessions Parents-Profs",
  },

  agenda_enseignant: {
    title: "📅 DB — Agenda enseignant",
  },

  periodes_scolaires: {
    title: "📅 DB — Périodes scolaires",
  },

  occurrences: {
    title: "📆 DB — Occurrences de cours",
  },

  taches_professeur: {
    title: "📌 DB - Tâches professeur",
  },

  bilans_classe: {
    title: "📊 DB — Bilans de classe",
  },

  inscriptions: {
    title: "🎒 DB — Inscriptions élèves",
  },

  suivi_quotidien: {
    title: "📋 DB — Suivi quotidien",
  },

  feuilles_appel: {
    title: "📝 DB — Feuilles d’appel",
  },

  presences: {
    title: "👤 DB — Présences",
  },
};

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

function normalizeDatabaseTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00A0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
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

  return connection;
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

function findExactMatches(
  databases,
  expectedTitle
) {
  const normalizedExpectedTitle =
    normalizeDatabaseTitle(
      expectedTitle
    );

  return databases.filter(
    (database) =>
      normalizeDatabaseTitle(
        getDatabaseTitle(database)
      ) === normalizedExpectedTitle
  );
}

function exportProperties(database) {
  const properties =
    database?.properties || {};

  const exported = {};

  /*
    Tri alphabétique volontaire.

    Cela rend le fichier généré :
    - stable ;
    - lisible ;
    - facile à comparer dans Git.
  */
  const entries =
    Object.entries(properties)
      .sort(
        ([nameA], [nameB]) =>
          nameA.localeCompare(
            nameB,
            "fr"
          )
      );

  for (
    const [propertyName, property]
    of entries
  ) {
    exported[propertyName] =
      property?.type || null;
  }

  return exported;
}

function buildSchema(
  databases
) {
  const schema = {};

  const missing = [];
  const ambiguous = [];

  for (
    const [componentKey, definition]
    of Object.entries(
      OFFICIAL_DATABASES
    )
  ) {
    const matches =
      findExactMatches(
        databases,
        definition.title
      );

    if (matches.length === 0) {
      missing.push({
        component_key:
          componentKey,

        expected_title:
          definition.title,
      });

      continue;
    }

    if (matches.length > 1) {
      ambiguous.push({
        component_key:
          componentKey,

        expected_title:
          definition.title,

        candidates:
          matches.map(
            (database) => ({
              id:
                database.id,

              title:
                getDatabaseTitle(
                  database
                ),
            })
          ),
      });

      continue;
    }

    const database =
      matches[0];

    schema[componentKey] = {
      title:
        getDatabaseTitle(
          database
        ),

      requiredProperties:
        exportProperties(
          database
        ),
    };
  }

  return {
    schema,
    missing,
    ambiguous,
  };
}

function serializeSchema(schema) {
  return JSON.stringify(
    schema,
    null,
    2
  );
}

function generateJavaScriptFile(
  schema
) {
  const serializedSchema =
    serializeSchema(schema);

  return [
    "/*",
    "  Schéma officiel de Mi Espacio Docente.",
    "",
    "  Fichier généré automatiquement.",
    "  Ne contient :",
    "  - aucun database_id Notion ;",
    "  - aucune URL Notion ;",
    "  - aucun access_token ;",
    "  - aucune donnée utilisateur.",
    "",
    "  Ce fichier constitue le contrat",
    "  structurel de référence du template.",
    "*/",
    "",
    'export const MI_ESPACIO_DOCENTE_SCHEMA_VERSION = "1.0.0";',
    "",
    "export const MI_ESPACIO_DOCENTE_SCHEMA =",
    `${serializedSchema};`,
    "",
    "export default MI_ESPACIO_DOCENTE_SCHEMA;",
    "",
  ].join("\n");
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

    const connection =
      await getConnection(req);

    const databases =
      await searchAllDatabases(
        connection.access_token
      );

    const {
      schema,
      missing,
      ambiguous,
    } = buildSchema(databases);

    const expectedCount =
      Object.keys(
        OFFICIAL_DATABASES
      ).length;

    const detectedCount =
      Object.keys(schema).length;

    /*
      Sécurité absolue :
      on refuse de générer le fichier
      si les 33 bases ne sont pas
      identifiées sans ambiguïté.
    */
    if (
      missing.length > 0 ||
      ambiguous.length > 0 ||
      detectedCount !== expectedCount
    ) {
      return res
        .status(409)
        .json({
          ok: false,

          message:
            "Génération refusée : " +
            "le workspace ne correspond " +
            "pas exactement aux 33 bases " +
            "officielles attendues.",

          diagnostic: {
            workspace_id:
              connection.workspace_id,

            workspace_name:
              connection.workspace_name ||
              null,

            accessible_database_count:
              databases.length,

            expected_database_count:
              expectedCount,

            detected_database_count:
              detectedCount,

            missing_count:
              missing.length,

            ambiguous_count:
              ambiguous.length,
          },

          missing,

          ambiguous,
        });
    }

    const javascript =
      generateJavaScriptFile(
        schema
      );

    /*
      Réponse en texte JavaScript brut.

      Le navigateur affichera directement
      le contenu final à copier dans :
      /lib/mi-espacio-docente-schema.js
    */
    res.setHeader(
      "Content-Type",
      "text/javascript; charset=utf-8"
    );

    res.setHeader(
      "Content-Disposition",
      'inline; filename="mi-espacio-docente-schema.js"'
    );

    res.setHeader(
      "Cache-Control",
      "no-store, max-age=0"
    );

    return res
      .status(200)
      .send(javascript);
  } catch (error) {
    console.error(
      "Erreur génération schéma :",
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
