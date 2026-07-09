import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2022-06-28";

/*
  Les 33 bases officielles de Mi Espacio Docente.

  - Les 4 bases déjà connues conservent une validation
    stricte de leurs propriétés.
  - Les 29 autres sont détectées par titre exact.
  - Aucun ID Notion n'est codé en dur.
*/

const REQUIRED_DATABASES = {
  anneesScolaires: {
    title: "📅 DB — Années scolaires",
  },

  classes: {
    title: "🎓 DB — Classes",
  },

  eleves: {
    title: "👨‍🎓 DB — Élèves",
  },

  besoinsParticuliers: {
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

  journalClasse: {
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

  suiviOral: {
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

  maitriseCompetences: {
    title: "📊 DB — Maîtrise des compétences",
  },

  ressources: {
    title: "📄 DB — Ressources",
  },

  observationsPedagogiques: {
    title: "📊 DB — Observations pédagogiques",
  },

  objectifsIndividuels: {
    title: "🎯 DB — Objectifs individuels",
  },

  etablissements: {
    title: "🏫 DB — Établissements",
  },

  emploiDuTemps: {
    title: "🎓 DB — Emploi du temps",
  },

  rdvParents: {
    title: "👥 DB — RDV Parents",
  },

  rdvParentsProfs: {
    title: "🏫 DB — RDV Parents-Profs",
  },

  sessionsParentsProfs: {
    title: "📅 DB — Sessions Parents-Profs",
  },

  agendaEnseignant: {
    title: "📅 DB — Agenda enseignant",
  },

  periodesScolaires: {
    title: "📅 DB — Périodes scolaires",
  },

  occurrences: {
    title: "📆 DB — Occurrences de cours",

    requiredProperties: {
      "📆 Cours prévu": "title",
      "📅 Date et heure": "date",
      "🏁 Fin": "date",
      "🎓 Classe": "relation",
      "📋 Feuilles d’appel": "relation",
    },
  },

  tachesProfesseur: {
    title: "📌 DB - Tâches professeur",
  },

  bilansClasse: {
    title: "📊 DB — Bilans de classe",
  },

  inscriptions: {
    title: "🎒 DB — Inscriptions élèves",

    requiredProperties: {
      "🎒 Inscription": "title",
      "🎓 Classe": "relation",
      "👨‍🎓 Élève": "relation",
      "👤 Présences": "relation",
    },
  },

  suiviQuotidien: {
    title: "📋 DB — Suivi quotidien",
  },

  feuillesAppel: {
    title: "📝 DB — Feuilles d’appel",

    requiredProperties: {
      "📝 Entrée d’appel": "title",
      "🎓 Classe": "relation",
      "👤 Présences": "relation",
      "📅 Occurrence de cours": "relation",
      "📅 Date et heure de l’appel": "date",
    },
  },

  presences: {
    title: "👤 DB — Présences",

    requiredProperties: {
      "👤 Entrée de présence": "title",
      "🎒 Inscription élève": "relation",
      "✅ Statut de présence": "select",
      "📋 Feuille d’appel": "relation",
    },
  },
};

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";

  const cookies = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim());

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");

    if (separatorIndex === -1) continue;

    const key = cookie.slice(0, separatorIndex);
    const value = cookie.slice(separatorIndex + 1);

    if (key === name) {
      return decodeURIComponent(value);
    }
  }

  return null;
}

function getPlainText(items = []) {
  return items
    .map((item) => item?.plain_text || "")
    .join("")
    .trim();
}

async function notion(
  accessToken,
  path,
  options = {}
) {
  const cleanPath = path.startsWith("/")
    ? path
    : `/${path}`;

  const url =
    `https://api.notion.com/v1${cleanPath}`;

  const response = await fetch(url, {
    ...options,

    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    const error = new Error(
      `Notion ${response.status} sur ${url}: ` +
      `${JSON.stringify(data)}`
    );

    error.statusCode = response.status;

    throw error;
  }

  return data;
}

async function getConnection(req) {
  const databaseUrl = process.env.DATABASE_URL;

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

  if (!connection || !connection.access_token) {
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

async function searchAllDatabases(accessToken) {
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
      body.start_cursor = startCursor;
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

    hasMore = Boolean(result.has_more);

    startCursor =
      result.next_cursor || undefined;
  }

  return databases;
}

function getDatabaseTitle(database) {
  return (
    getPlainText(database?.title || []) ||
    "(Sans titre)"
  );
}

function validateDatabase(
  database,
  requiredProperties = null
) {
  /*
    Si aucune structure n'est encore connue,
    le titre exact suffit pour cette première
    version d'installation.
  */

  if (!requiredProperties) {
    return {
      valid: true,
      missing: [],
      wrongTypes: [],
    };
  }

  const actualProperties =
    database?.properties || {};

  const missing = [];
  const wrongTypes = [];

  for (
    const [propertyName, expectedType]
    of Object.entries(requiredProperties)
  ) {
    const actualProperty =
      actualProperties[propertyName];

    if (!actualProperty) {
      missing.push(propertyName);
      continue;
    }

    if (actualProperty.type !== expectedType) {
      wrongTypes.push({
        property: propertyName,
        expected: expectedType,
        actual:
          actualProperty.type || null,
      });
    }
  }

  return {
    valid:
      missing.length === 0 &&
      wrongTypes.length === 0,

    missing,
    wrongTypes,
  };
}

function findDatabase(
  databases,
  definition
) {
  const exactTitleMatches =
    databases.filter(
      (database) =>
        getDatabaseTitle(database) ===
        definition.title
    );

  const evaluated =
    exactTitleMatches.map(
      (database) => ({
        database,

        validation: validateDatabase(
          database,
          definition.requiredProperties
        ),
      })
    );

  const validMatches =
    evaluated.filter(
      (item) => item.validation.valid
    );

  if (validMatches.length === 1) {
    return {
      status: "found",

      database:
        validMatches[0].database,

      validation:
        validMatches[0].validation,
    };
  }

  if (validMatches.length > 1) {
    return {
      status: "ambiguous",
      database: null,

      candidates:
        validMatches.map(
          (item) => ({
            id: item.database.id,

            title:
              getDatabaseTitle(
                item.database
              ),

            url:
              item.database.url || null,
          })
        ),
    };
  }

  if (exactTitleMatches.length > 0) {
    return {
      status: "invalid_structure",
      database: null,

      candidates:
        evaluated.map(
          (item) => ({
            id: item.database.id,

            title:
              getDatabaseTitle(
                item.database
              ),

            validation:
              item.validation,
          })
        ),
    };
  }

  return {
    status: "not_found",
    database: null,
  };
}

function toComponentKey(key) {
  const mapping = {
    anneesScolaires: "annees_scolaires",
    classes: "classes",
    eleves: "eleves",
    besoinsParticuliers: "besoins_particuliers",
    adaptations: "adaptations",
    incidents: "incidents",
    remediations: "remediations",
    journalClasse: "journal_classe",
    devoirs: "devoirs",
    sequences: "sequences",
    seances: "seances",
    suiviOral: "suivi_oral",
    evaluations: "evaluations",
    resultats: "resultats",
    competences: "competences",
    maitriseCompetences:
      "maitrise_competences",
    ressources: "ressources",
    observationsPedagogiques:
      "observations_pedagogiques",
    objectifsIndividuels:
      "objectifs_individuels",
    etablissements: "etablissements",
    emploiDuTemps: "emploi_du_temps",
    rdvParents: "rdv_parents",
    rdvParentsProfs: "rdv_parents_profs",
    sessionsParentsProfs:
      "sessions_parents_profs",
    agendaEnseignant: "agenda_enseignant",
    periodesScolaires: "periodes_scolaires",
    occurrences: "occurrences",
    tachesProfesseur: "taches_professeur",
    bilansClasse: "bilans_classe",
    inscriptions: "inscriptions",
    suiviQuotidien: "suivi_quotidien",
    feuillesAppel: "feuilles_appel",
    presences: "presences",
  };

  return mapping[key] || key;
}

export default async function handler(
  req,
  res
) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");

      return res
        .status(405)
        .send("Méthode non autorisée");
    }

    const {
      sql,
      connection,
    } = await getConnection(req);

    const databases =
      await searchAllDatabases(
        connection.access_token
      );

    const detection = {};

    for (
      const [key, definition]
      of Object.entries(
        REQUIRED_DATABASES
      )
    ) {
      detection[key] = findDatabase(
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
          ([key, result]) => ({
            key,

            component_key:
              toComponentKey(key),

            expected_title:
              REQUIRED_DATABASES[key].title,

            status:
              result.status,

            candidates:
              result.candidates || [],
          })
        );

    if (failures.length > 0) {
      return res.status(422).json({
        ok: false,

        error:
          "Installation automatique impossible : " +
          "certaines bases sont absentes, " +
          "ambiguës ou invalides.",

        diagnostic: {
          workspace_id:
            connection.workspace_id,

          workspace_name:
            connection.workspace_name ||
            null,

          database_count:
            databases.length,

          expected_database_count:
            Object.keys(
              REQUIRED_DATABASES
            ).length,

          detected_database_count:
            Object.values(detection)
              .filter(
                (result) =>
                  result.status === "found"
              )
              .length,
        },

        failures,
      });
    }

    /*
      Enregistrement des 33 composants.

      Une ligne par base :
      workspace_id + component_key
    */

    for (
      const [key, result]
      of Object.entries(detection)
    ) {
      const database =
        result.database;

      const componentKey =
        toComponentKey(key);

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
      Compatibilité avec le système actuel.

      On continue à remplir
      notion_workspace_config
      pour que faire-appel.js
      puisse être migré progressivement.
    */

    const occurrencesDb =
      detection.occurrences.database;

    const inscriptionsDb =
      detection.inscriptions.database;

    const presencesDb =
      detection.presences.database;

    const feuillesAppelDb =
      detection.feuillesAppel.database;

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

    for (
      const [key, result]
      of Object.entries(detection)
    ) {
      detected[
        toComponentKey(key)
      ] = {
        id:
          result.database.id,

        title:
          getDatabaseTitle(
            result.database
          ),
      };
    }

    return res.status(200).json({
      ok: true,

      message:
        "Installation complète de Mi Espacio Docente réussie.",

      workspace: {
        id:
          connection.workspace_id,

        name:
          connection.workspace_name ||
          null,
      },

      summary: {
        expected: 33,
        detected:
          Object.keys(detected).length,

        saved_components:
          Object.keys(detected).length,

        legacy_config_updated: true,
      },

      detected,

      saved_to_neon: true,
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
