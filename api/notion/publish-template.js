import { neon } from "@neondatabase/serverless";

import {
  NOTION_VERSION,
  getCookie,
  notion,
  listAllTemplates,
  findTemplateById,
  readBlockTree,
  calculateFingerprint,
  buildSnapshot,
} from "./sync-engine.js";

function incrementPatchVersion(version) {
  const parts = String(version || "1.0.0")
    .split(".")
    .map((part) => {
      const match = String(part).match(/^\d+/);
      return match ? Number(match[0]) : 0;
    });

  while (parts.length < 3) {
    parts.push(0);
  }

  parts[2] += 1;

  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

async function getContext(req, templateKey) {
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

  const connectionRows = await sql`
    SELECT
      workspace_id,
      workspace_name,
      access_token
    FROM notion_connections
    WHERE workspace_id = ${workspaceId}
    LIMIT 1
  `;

  const connection = connectionRows[0];

  if (!connection?.access_token) {
    const error = new Error(
      "Connexion Notion introuvable ou expirée."
    );

    error.statusCode = 401;

    throw error;
  }

  const officialRows = await sql`
    SELECT
      id,
      template_key,
      component_key,
      notion_template_name,
      master_workspace_id,
      master_notion_template_id,
      master_notion_data_source_id,
      official_version,
      official_fingerprint,
      is_default,
      is_active,
      propagate_new_installations,
      propagate_existing_installations,
      create_if_missing,
      update_if_outdated,
      overwrite_local_changes,
      local_changes_policy,
      created_at,
      updated_at
    FROM notion_official_templates
    WHERE template_key = ${templateKey}
    LIMIT 1
  `;

  const official = officialRows[0];

  if (!official) {
    const error = new Error(
      `Template officiel introuvable : ${templateKey}`
    );

    error.statusCode = 404;

    throw error;
  }

  if (!official.is_active) {
    const error = new Error(
      "Le template officiel est désactivé."
    );

    error.statusCode = 409;

    throw error;
  }

  return {
    sql,
    connection,
    official,
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");

      return res.status(405).json({
        ok: false,
        error: "Méthode non autorisée",
      });
    }

    const templateKey = String(
      req.body?.template_key || ""
    ).trim();

    if (!templateKey) {
      return res.status(400).json({
        ok: false,
        error:
          "template_key est obligatoire.",
      });
    }

    const {
      sql,
      connection,
      official,
    } = await getContext(
      req,
      templateKey
    );

    if (
  official.master_workspace_id &&
  official.master_workspace_id !==
    connection.workspace_id
) {
  return res.status(409).json({
    ok: false,

    engine_stage: "3/6",

    status: "wrong_workspace",

    error:
      "Publication refusée hors du workspace maître.",
  });
}

    if (
  !official.master_notion_template_id ||
  !official.master_notion_data_source_id
) {
  return res.status(409).json({
    ok: false,

    engine_stage: "3/6",

    status: "official_reference_incomplete",

    error:
      "Référence officielle incomplète.",
  });
}

    const accessToken =
      connection.access_token;

    const templates =
      await listAllTemplates(
        accessToken,
        official.master_notion_data_source_id
      );

    const masterTemplate =
      findTemplateById(
        templates,
        official.master_notion_template_id
      );

    if (!masterTemplate) {
      return res.status(409).json({
        ok: false,
        engine_stage: "3/6",
        status:
          "master_template_not_detected",
        error:
          "Le template maître officiel n'est plus détecté dans Notion.",
      });
    }

    await notion(
      accessToken,
      `/pages/${masterTemplate.id}`,
      {
        method: "GET",
      }
    );

    const masterTree =
      await readBlockTree(
        accessToken,
        masterTemplate.id
      );

    const currentFingerprint =
      calculateFingerprint(masterTree);

    const currentSnapshot =
  buildSnapshot(masterTree);

    const previousFingerprint =
      official.official_fingerprint;

    const previousVersion =
      official.official_version;

      /*
      Si le fingerprint n'a pas changé,
      aucune nouvelle version n'est publiée.
    */
    if (
      currentFingerprint ===
      previousFingerprint
    ) {
      return res.status(200).json({
        ok: true,

        engine_stage: "3/6",

        status: "already_current",

        message:
          "Le template officiel est déjà à jour.",

        workspace: {
          id: connection.workspace_id,
          name:
            connection.workspace_name ||
            null,
        },

        template: {
          template_key:
            official.template_key,

          component_key:
            official.component_key,

          name:
            official.notion_template_name,

          template_id:
            masterTemplate.id,
        },

        version: {
          current:
            previousVersion,
        },

        fingerprint: {
          current:
            currentFingerprint,
        },

        safety: {
          notion_write_operations: 0,
          neon_write_operations: 0,
          official_registry_modified: false,
        },
      });
    }

    /*
      Nouveau fingerprint détecté.
      On prépare une nouvelle version.
    */
    const nextVersion =
      incrementPatchVersion(
        previousVersion
      );

    /*
      Mise à jour du registre officiel.
    */
    const updatedRows = await sql`
   UPDATE notion_official_templates
SET
    official_version = ${nextVersion},
    official_fingerprint = ${currentFingerprint},
    updated_at = now()

WHERE
    id = ${official.id}

AND
    official_fingerprint = ${previousFingerprint}

RETURNING
    id,
    template_key,
    component_key,
    notion_template_name,
    master_workspace_id,
    master_notion_template_id,
    master_notion_data_source_id,
    official_version,
    official_fingerprint,
    updated_at
    `;

const published = updatedRows[0] || null;

if (!published) {
    return res.status(409).json({
        ok: false,

        engine_stage: "3/6",

        status: "publication_conflict",

        error:
            "Une autre publication a été effectuée pendant cette opération. Rechargez puis republiez."
    });
}

    /*
      Relecture immédiate afin de prouver
      que Neon contient bien la nouvelle
      version officielle.
    */

    const verificationRows =
      await sql`
        SELECT
          official_version,
          official_fingerprint,
          updated_at

        FROM notion_official_templates

        WHERE id = ${official.id}

        LIMIT 1
      `;

    const verification =
      verificationRows[0];

    if (
      !verification ||
      verification.official_version !==
        nextVersion ||
      verification.official_fingerprint !==
        currentFingerprint
    ) {
      return res.status(500).json({
        ok: false,

        engine_stage: "3/6",

        status:
          "publication_verification_failed",

        error:
          "La publication n'a pas pu être vérifiée après écriture.",
      });
    }

      /*
      Construction de la réponse officielle
      de publication.
    */

    return res.status(200).json({
      ok: true,

      engine_stage: "3/6",

      status: "published",

      message:
        "Le template officiel a été publié avec succès.",

      notion_api_version:
        NOTION_VERSION,

      workspace: {
        id: connection.workspace_id,

        name:
          connection.workspace_name ||
          null,
      },

      template: {
        template_key:
          published.template_key,

        component_key:
          published.component_key,

        name:
          published.notion_template_name,

        master_workspace_id:
          published.master_workspace_id,

        master_template_id:
          published.master_notion_template_id,

        master_data_source_id:
          published.master_notion_data_source_id,
      },

      publication: {
        previous_version:
          previousVersion,

        published_version:
          nextVersion,

        previous_fingerprint:
          previousFingerprint,

        published_fingerprint:
          currentFingerprint,

        snapshot:
        currentSnapshot,

        fingerprint_changed:
          previousFingerprint !==
          currentFingerprint,

        version_incremented:
          previousVersion !==
          nextVersion,
      },

      verification: {
        registry_updated: true,

        official_version:
          verification.official_version,

        official_fingerprint:
          verification.official_fingerprint,

        fingerprint_verified:
          verification.official_fingerprint ===
          currentFingerprint,

        version_verified:
          verification.official_version ===
          nextVersion,
      },

      safety: {
        notion_write_operations: 0,

        neon_write_operations: 1,

        official_registry_modified: true,

        user_workspace_modified: false,

        user_templates_modified: false,

        automatic_sync_executed: false,
      },
    });

  } catch (error) {

    console.error(
      "Erreur publish-template :",
      error
    );

    return res
      .status(
        error.statusCode || 500
      )
      .json({
        ok: false,

        engine_stage: "3/6",

        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}

/*
  Exports internes optionnels
  pour les tests unitaires.

  Aucun impact sur l'endpoint Vercel :
  l'export default handler reste inchangé.
*/

export {
  incrementPatchVersion,
  getContext,
};
