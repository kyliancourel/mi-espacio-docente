const NOTION_VERSION = "2026-03-11";

const IDS = {
  occurrencesDb: "39440bd7-969d-8096-b622-ee9c8ed30757",
  inscriptionsDb: "39440bd7-969d-80a4-8346-fb9f05141744",
  presencesDb: "39540bd7-969d-8012-8566-daea2c7f2742",
  feuillesAppelDb: "39540bd7-969d-8052-a10b-f07a5c691a9f",
  feuilleTemplate: "39740bd7-969d-808f-b743-c8e7f9e4d928",
};

function notionHeaders() {
  return {
    Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function notion(path, options = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      ...notionHeaders(),
      ...(options.headers || {}),
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Notion ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

function notionPageUrl(pageId) {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

function htmlRedirect(url) {
  const safeUrl = JSON.stringify(url);

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="0;url=${url}">
  <title>Ouverture de la feuille d'appel</title>
  <script>
    window.location.replace(${safeUrl});
  </script>
</head>
<body>
  <p>Ouverture de la feuille d'appel...</p>
</body>
</html>`;
}

function getRelationIds(page, propertyName) {
  const property = page?.properties?.[propertyName];
  if (!property || property.type !== "relation") return [];
  return (property.relation || []).map((item) => item.id);
}

function getTitle(page, propertyName) {
  const property = page?.properties?.[propertyName];
  if (!property || property.type !== "title") return "";
  return (property.title || [])
    .map((item) => item.plain_text || "")
    .join("");
}

function getPageTitle(page) {
  for (const property of Object.values(page?.properties || {})) {
    if (property?.type === "title") {
      return (property.title || [])
        .map((item) => item.plain_text || "")
        .join("");
    }
  }

  return "Classe";
}

function formatParisDate(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function formatParisTime(date) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export default async function handler(req, res) {
  try {
    if (!process.env.NOTION_TOKEN) {
      throw new Error("Variable NOTION_TOKEN absente dans Vercel.");
    }

    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).send("Méthode non autorisée");
    }

    const now = new Date();
    const nowIso = now.toISOString();

    // 1. Trouver l'occurrence de cours actuellement en cours
    const occurrenceResult = await notion(
      `/databases/${IDS.occurrencesDb}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            and: [
              {
                property: "📅 Date et heure",
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

    const occurrence = occurrenceResult.results?.[0];

    if (!occurrence) {
      return res
        .status(404)
        .send("Aucun cours en cours n'a été trouvé.");
    }

    // 2. Récupérer la classe liée
    const classeIds = getRelationIds(occurrence, "🎓 Classe");
    const classeId = classeIds[0];

    if (!classeId) {
      throw new Error(
        "L'occurrence en cours ne contient aucune relation « 🎓 Classe »."
      );
    }

    const classe = await notion(`/pages/${classeId}`, {
      method: "GET",
    });

    const classeNom = getPageTitle(classe) || "Classe";

    // 3. Vérifier si une feuille d'appel existe déjà
    const feuilleIds = getRelationIds(
      occurrence,
      "📝 Feuilles d'appel"
    );

    if (feuilleIds.length > 0) {
      const feuilleExistante = await notion(
        `/pages/${feuilleIds[0]}`,
        {
          method: "GET",
        }
      );

      const url =
        feuilleExistante.url ||
        notionPageUrl(feuilleIds[0]);

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(htmlRedirect(url));
    }

    // 4. Trouver toutes les inscriptions de la classe
    const inscriptionsResult = await notion(
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

    const inscriptions = inscriptionsResult.results || [];

    if (inscriptions.length === 0) {
      throw new Error(
        `Aucune inscription trouvée pour la classe « ${classeNom} ».`
      );
    }

    // 5. Créer une entrée de présence par inscription
    const presenceIds = [];

    for (const inscription of inscriptions) {
      const nomInscription =
        getTitle(inscription, "🎒 Inscription") ||
        "Élève";

      const presence = await notion("/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: {
            database_id: IDS.presencesDb,
          },
          properties: {
            "👤 Entrée de présence": {
              title: [
                {
                  text: {
                    content: nomInscription,
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
                name: "🟢 Présent(e)",
              },
            },
          },
        }),
      });

      presenceIds.push(presence.id);
    }

    // 6. Préparer la nouvelle feuille d'appel
    const titreAppel =
      `APPEL - ${classeNom} - ` +
      `${formatParisDate(now)} - ${formatParisTime(now)}`;

    // 7. Créer la feuille avec ton template Notion
    const feuille = await notion("/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: {
          database_id: IDS.feuillesAppelDb,
        },

        template: {
          type: "template_id",
          template_id: IDS.feuilleTemplate,
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

          "👤 Présences": {
            relation: presenceIds.map((id) => ({ id })),
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
    });

    // 8. Rediriger automatiquement vers la feuille créée
    const url = feuille.url || notionPageUrl(feuille.id);

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(htmlRedirect(url));
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
