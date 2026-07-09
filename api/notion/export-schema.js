import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2022-06-28";

/*
  Les 33 bases officielles de Mi Espacio Docente.

  Cet endpoint :
  - cherche uniquement ces 33 titres ;
  - détecte les absences et doublons ;
  - exporte toutes les propriétés réelles ;
  - ne modifie rien dans Notion ;
  - ne modifie rien dans Neon.
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
    title: "📦 DB — Journal de classe",
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
    title: "👥 DB — RDV Parents",
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
  const cookieHeader = req.headers.cookie || "";

  const cookies = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim());

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");

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

function exportProperties(database) {
  const properties =
    database?.properties || {};

  const exported = {};

  for (
    const [propertyName, property]
    of Object.entries(properties)
  ) {
    exported[propertyName] =
      property?.type || null;
  }

  return exported;
}

function findExactMatches(
  databases,
  expectedTitle
) {
  return databases.filter(
    (database) =>
      getDatabaseTitle(database) ===
      expectedTitle
  );
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

    const schemas = {};
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

                url:
                  database.url || null,
              })
            ),
        });

        continue;
      }

      const database = matches[0];

      schemas[componentKey] = {
        title:
          getDatabaseTitle(
            database
          ),

        database_id:
          database.id,

        url:
          database.url || null,

        property_count:
          Object.keys(
            database.properties || {}
          ).length,

        requiredProperties:
          exportProperties(database),
      };
    }

    const detectedCount =
      Object.keys(schemas).length;

    const expectedCount =
      Object.keys(
        OFFICIAL_DATABASES
      ).length;

    return res.status(200).json({
      ok:
        missing.length === 0 &&
        ambiguous.length === 0,

      message:
        missing.length === 0 &&
        ambiguous.length === 0
          ? (
              "Export complet du schéma " +
              "Mi Espacio Docente réussi."
            )
          : (
              "Export partiel : certaines " +
              "bases sont absentes ou ambiguës."
            ),

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

      schemas,
    });
  } catch (error) {
    console.error(
      "Erreur export schéma Notion :",
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
