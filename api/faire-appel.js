import { neon } from "@neondatabase/serverless";

const NOTION_VERSION = "2022-06-28";

const IDS = {
  occurrencesDb: "39440bd7-969d-8096-b622-ee9c8ed30757",
  inscriptionsDb: "39440bd7-969d-80a4-8346-fb9f05141744",
  presencesDb: "39540bd7-969d-8012-8566-daea2c7f2742",
  feuillesAppelDb: "39540bd7-969d-8052-a10b-f07a5c691a9f",
  feuilleTemplate: "39740bd7-969d-808f-b743-c8e7f9e4d928",
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

async function getNotionConnection(req) {
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
      workspace_icon,
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

  return connection;
}

function notionHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
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
      ...notionHeaders(accessToken),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

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
    throw new Error(
      `Notion ${response.status} sur ${url}: ` +
      `${JSON.stringify(data)}`
    );
  }

  return data;
}

function notionPageUrl(pageId) {
  return (
    `https://www.notion.so/` +
    pageId.replace(/-/g, "")
  );
}

function htmlRedirect(url) {
  const safeUrl = JSON.stringify(url);

  const escapedHref = String(url)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <meta
    http-equiv="refresh"
    content="0;url=${escapedHref}"
  >

  <title>
    Ouverture de la feuille d'appel
  </title>

  <script>
    window.location.replace(${safeUrl});
  </script>
</head>

<body>
  <p>
    Ouverture de la feuille d'appel...
  </p>

  <p>
    <a href="${escapedHref}">
      Cliquez ici si la redirection ne démarre pas.
    </a>
  </p>
</body>
</html>`;
}

function redirectToPage(res, pageOrId) {
  const url =
    typeof pageOrId === "string"
      ? notionPageUrl(pageOrId)
      : (
          pageOrId.url ||
          notionPageUrl(pageOrId.id)
        );

  res.setHeader(
    "Content-Type",
    "text/html; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  return res
    .status(200)
    .send(htmlRedirect(url));
}

function getRelationIds(page, propertyName) {
  const property =
    page?.properties?.[propertyName];

  if (
    !property ||
    property.type !== "relation"
  ) {
    return [];
  }

  return (property.relation || [])
    .map((item) => item.id)
    .filter(Boolean);
}

function getTitle(page, propertyName) {
  const property =
    page?.properties?.[propertyName];

  if (
    !property ||
    property.type !== "title"
  ) {
    return "";
  }

  return (property.title || [])
    .map((item) => item.plain_text || "")
    .join("");
}

function getPageTitle(page) {
  for (
    const property of Object.values(
      page?.properties || {}
    )
  ) {
    if (property?.type === "title") {
      return (property.title || [])
        .map(
          (item) =>
            item.plain_text || ""
        )
        .join("");
    }
  }

  return "Classe";
}

function formatParisDate(date) {
  return new Intl.DateTimeFormat(
    "fr-FR",
    {
      timeZone: "Europe/Paris",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }
  ).format(date);
}

function formatParisTime(date) {
  return new Intl.DateTimeFormat(
    "fr-FR",
    {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }
  ).format(date);
}

async function findExistingSheet(
  accessToken,
  occurrence
) {
  // Contrôle 1 :
  // relation directe depuis l'occurrence
  const linkedSheetIds = getRelationIds(
    occurrence,
    "📋 Feuilles d’appel"
  );

  if (linkedSheetIds.length > 0) {
    const sheet = await notion(
      accessToken,
      `/pages/${linkedSheetIds[0]}`,
      {
        method: "GET",
      }
    );

    if (
      !sheet.archived &&
      !sheet.in_trash
    ) {
      return sheet;
    }
  }

  // Contrôle 2 :
  // recherche inverse dans la DB
  const result = await notion(
    accessToken,
    `/databases/${IDS.feuillesAppelDb}/query`,
    {
      method: "POST",

      body: JSON.stringify({
        filter: {
          property:
            "📅 Occurrence de cours",

          relation: {
            contains: occurrence.id,
          },
        },

        page_size: 10,
      }),
    }
  );

  return (
    (result.results || []).find(
      (page) =>
        !page.archived &&
        !page.in_trash
    ) || null
  );
}

export default async function handler(
  req,
  res
) {
  try {
    // 1. Autoriser uniquement GET
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");

      return res
        .status(405)
        .send("Méthode non autorisée");
    }

    // 2. Charger la connexion OAuth
    const connection =
      await getNotionConnection(req);

    const accessToken =
      connection.access_token;

    const now = new Date();
    const nowIso = now.toISOString();

    // 3. Trouver le cours en cours
    const occurrenceResult = await notion(
      accessToken,
      `/databases/${IDS.occurrencesDb}/query`,
      {
        method: "POST",

        body: JSON.stringify({
          filter: {
            and: [
              {
                property:
                  "📅 Date et heure",

                date: {
                  on_or_before: nowIso,
                },
              },

              {
                property: "🏁 Fin",

                date: {
                  on_or_after: nowIso,
                },
              },
            ],
          },

          page_size: 10,
        }),
      }
    );

    const occurrence =
      occurrenceResult.results?.[0];

    if (!occurrence) {
      return res
        .status(404)
        .send(
          "Aucun cours en cours n'a été trouvé."
        );
    }

    // 4. Vérifier si une feuille
    // existe déjà
    const existingSheet =
      await findExistingSheet(
        accessToken,
        occurrence
      );

    if (existingSheet) {
      return redirectToPage(
        res,
        existingSheet
      );
    }

    // 5. Récupérer la classe
    const classeIds = getRelationIds(
      occurrence,
      "🎓 Classe"
    );

    const classeId = classeIds[0];

    if (!classeId) {
      throw new Error(
        "L'occurrence en cours ne contient " +
        "aucune relation « 🎓 Classe »."
      );
    }

    const classe = await notion(
      accessToken,
      `/pages/${classeId}`,
      {
        method: "GET",
      }
    );

    const classeNom =
      getPageTitle(classe) || "Classe";

    // 6. Trouver les inscriptions
    // de la classe
    const inscriptionsResult =
      await notion(
        accessToken,
        `/databases/${IDS.inscriptionsDb}/query`,
        {
          method: "POST",

          body: JSON.stringify({
            filter: {
              property: "🎓 Classe",

              relation: {
                contains: classeId,
              },
            },

            page_size: 100,
          }),
        }
      );

    const inscriptions =
      inscriptionsResult.results || [];

    if (inscriptions.length === 0) {
      throw new Error(
        `Aucune inscription trouvée ` +
        `pour la classe « ${classeNom} ».`
      );
    }

    // 7. Recontrôle avant création
    const sheetAfterLookup =
      await findExistingSheet(
        accessToken,
        occurrence
      );

    if (sheetAfterLookup) {
      return redirectToPage(
        res,
        sheetAfterLookup
      );
    }

    // 8. Préparer le titre
    const titreAppel =
      `APPEL - ${classeNom} - ` +
      `${formatParisDate(now)} - ` +
      `${formatParisTime(now)}`;

    // 9. Créer d'abord la feuille
    // sans présences
    const feuille = await notion(
      accessToken,
      "/pages",
      {
        method: "POST",

        body: JSON.stringify({
          parent: {
            database_id:
              IDS.feuillesAppelDb,
          },

          template: {
            type: "template_id",
            template_id:
              IDS.feuilleTemplate,
            timezone: "Europe/Paris",
          },

          properties: {
            "📝 Entrée d’appel": {
              title: [
                {
                  text: {
                    content: titreAppel,
                  },
                },
              ],
            },

            "🎓 Classe": {
              relation: [
                {
                  id: classeId,
                },
              ],
            },

            "📅 Occurrence de cours": {
              relation: [
                {
                  id: occurrence.id,
                },
              ],
            },

            "📅 Date et heure de l’appel": {
              date: {
                start: nowIso,
              },
            },
          },
        }),
      }
    );

    // 10. Créer une présence NEUVE
    // pour chaque inscription
    //
    // Important :
    // on ne recherche plus une ancienne
    // présence par inscription.
    const presenceIds = [];

    for (const inscription of inscriptions) {
      const nomInscription =
        getTitle(
          inscription,
          "🎒 Inscription"
        ) || "Élève";

      const presence = await notion(
        accessToken,
        "/pages",
        {
          method: "POST",

          body: JSON.stringify({
            parent: {
              database_id:
                IDS.presencesDb,
            },

            properties: {
              "👤 Entrée de présence": {
                title: [
                  {
                    text: {
                      content:
                        nomInscription,
                    },
                  },
                ],
              },

              "🎒 Inscription élève": {
                relation: [
                  {
                    id: inscription.id,
                  },
                ],
              },

              "✅ Statut de présence": {
                select: {
                  name:
                    "🟢 Présent(e)",
                },
              },
            },
          }),
        }
      );

      presenceIds.push(presence.id);
    }

    // 11. Rattacher toutes les nouvelles
    // présences à la feuille créée
    await notion(
      accessToken,
      `/pages/${feuille.id}`,
      {
        method: "PATCH",

        body: JSON.stringify({
          properties: {
            "👤 Présences": {
              relation:
                presenceIds.map(
                  (id) => ({
                    id,
                  })
                ),
            },
          },
        }),
      }
    );

    // 12. Récupérer la feuille mise à jour
    const updatedFeuille = await notion(
      accessToken,
      `/pages/${feuille.id}`,
      {
        method: "GET",
      }
    );

    // 13. Ouvrir la feuille
    return redirectToPage(
      res,
      updatedFeuille
    );
  } catch (error) {
    console.error(
      "Erreur Faire l'appel :",
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
