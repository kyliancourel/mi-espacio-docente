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
  applyTemplateNatively,
  waitForStableFingerprint,
} from "./sync-one.js";

const LAB_TEMPLATE_NAME =
  "🧪 TEMPLATE LABORATOIRE — FULL SYNC TEST";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");

      return res.status(405).json({
        ok: false,
        error: "Méthode non autorisée",
      });
    }

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
      return res.status(401).json({
        ok: false,
        engine_stage: "2/6",
        error:
          "Aucun espace Notion connecté pour cette session.",
      });
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
      return res.status(401).json({
        ok: false,
        engine_stage: "2/6",
        error:
          "Connexion Notion introuvable ou expirée.",
      });
    }

    /*
      On utilise le vrai registre central
      pour le master class_dashboard.
    */
    const officialRows = await sql`
      SELECT
        template_key,
        component_key,
        notion_template_name,
        master_workspace_id,
        master_notion_template_id,
        master_notion_data_source_id,
        official_version,
        official_fingerprint,
        is_active,
        propagate_existing_installations,
        update_if_outdated,
        overwrite_local_changes,
        local_changes_policy
      FROM notion_official_templates
      WHERE template_key = 'class_dashboard'
      LIMIT 1
    `;

    const official = officialRows[0];

    if (!official) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "official_template_not_registered",
        error:
          "Le template officiel class_dashboard est introuvable.",
      });
    }

    if (!official.is_active) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "official_template_inactive",
        error:
          "Le template officiel class_dashboard est désactivé.",
      });
    }

    if (
      !official.master_notion_template_id ||
      !official.master_notion_data_source_id ||
      !official.official_fingerprint
    ) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "official_reference_incomplete",
        error:
          "La référence officielle centrale est incomplète.",
      });
    }

    const accessToken = connection.access_token;

    /*
      Vérification stricte :
      ce test labo n'est autorisé que dans
      le workspace maître attendu.
    */
    if (
      official.master_workspace_id &&
      official.master_workspace_id !==
        connection.workspace_id
    ) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "wrong_workspace_for_lab_test",
        error:
          "Le test laboratoire est refusé hors du workspace maître.",
      });
    }

    /*
      On récupère tous les templates de la
      source de données du master.
    */
    const templates = await listAllTemplates(
      accessToken,
      official.master_notion_data_source_id
    );

    const masterTemplate = findTemplateById(
      templates,
      official.master_notion_template_id
    );

    if (!masterTemplate) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "master_template_not_detected",
        error:
          "Le template maître officiel n'est plus détecté.",
      });
    }

    /*
      Détection du template laboratoire
      uniquement par son nom exact.
    */
    const labMatches = templates.filter(
      (template) =>
        String(template?.name || "").trim() ===
        LAB_TEMPLATE_NAME
    );

    if (labMatches.length === 0) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "lab_template_missing",
        error:
          `Template laboratoire introuvable : ${LAB_TEMPLATE_NAME}`,
      });
    }

    if (labMatches.length > 1) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "ambiguous_lab_template",
        error:
          "Plusieurs templates laboratoire portent exactement le même nom. Test refusé.",
        match_count: labMatches.length,
      });
    }

    const labTemplate = labMatches[0];

    /*
      Barrière critique :
      la cible labo ne doit jamais être
      le template maître officiel.
    */
    if (
      String(labTemplate.id).replace(/-/g, "") ===
      String(masterTemplate.id).replace(/-/g, "")
    ) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "lab_target_is_master",
        error:
          "La cible laboratoire correspond au master officiel. Test destructif refusé.",
      });
    }

    /*
      Les deux objets doivent être lisibles
      comme pages avant toute écriture.
    */
    await notion(
      accessToken,
      `/pages/${masterTemplate.id}`,
      { method: "GET" }
    );

    await notion(
      accessToken,
      `/pages/${labTemplate.id}`,
      { method: "GET" }
    );

    /*
      Lecture réelle avant écriture.
    */
    const masterTree = await readBlockTree(
      accessToken,
      masterTemplate.id
    );

    const masterFingerprint =
      calculateFingerprint(masterTree);

    const masterSnapshot =
      buildSnapshot(masterTree);

    const labBeforeTree = await readBlockTree(
      accessToken,
      labTemplate.id
    );

    const labBeforeFingerprint =
      calculateFingerprint(labBeforeTree);

    const labBeforeSnapshot =
      buildSnapshot(labBeforeTree);

    /*
      Vérification du registre :
      le contenu réel du master doit
      correspondre au fingerprint officiel.
    */
    if (
      masterFingerprint !==
      official.official_fingerprint
    ) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "master_registry_drift",
        error:
          "Le master réel ne correspond plus au fingerprint officiel enregistré. Test destructif annulé.",

        fingerprints: {
          registered_official:
            official.official_fingerprint,
          current_master:
            masterFingerprint,
        },

        safety: {
          notion_write_operations: 0,
          neon_write_operations: 0,
          automatic_sync_executed: false,
        },
      });
    }

    /*
      Dernière relecture de la cible labo
      juste avant le PATCH : protection
      contre une modification concurrente.
    */
    const labPreWriteTree =
      await readBlockTree(
        accessToken,
        labTemplate.id
      );

    const labPreWriteFingerprint =
      calculateFingerprint(labPreWriteTree);

    if (
      labPreWriteFingerprint !==
      labBeforeFingerprint
    ) {
      return res.status(409).json({
        ok: false,
        engine_stage: "2/6",
        status: "concurrent_lab_change",
        error:
          "Le template laboratoire a changé pendant la préparation. Écriture annulée.",

        safety: {
          notion_write_operations: 0,
          neon_write_operations: 0,
          automatic_sync_executed: false,
        },
      });
    }

    /*
      ÉCRITURE RÉELLE :
      application native du master officiel
      sur le template laboratoire sacrificiel.
    */
    const nativeApplyResponse =
      await applyTemplateNatively({
        accessToken,
        targetTemplateId: labTemplate.id,
        sourceTemplateId: masterTemplate.id,
      });

    /*
      Vérification asynchrone réelle :
      on attend la correspondance exacte
      avec le fingerprint officiel.
    */
    const stabilization =
      await waitForStableFingerprint({
        accessToken,
        templateId: labTemplate.id,
        expectedFingerprint:
          official.official_fingerprint,
      });

    if (!stabilization.stable) {
      return res.status(500).json({
        ok: false,
        engine_stage: "2/6",
        status:
          "lab_native_sync_verification_failed",
        error:
          "Le PATCH natif a été accepté, mais le fingerprint final officiel n'a pas été confirmé.",

        native_apply: {
          accepted: true,
          response_id:
            nativeApplyResponse?.id || null,
        },

        stabilization,

        safety: {
          notion_write_operations: 1,
          neon_write_operations: 0,
          lab_template_modified: true,
          official_template_modified: false,
        },
      });
    }

    return res.status(200).json({
      ok: true,

      message:
        "Test laboratoire de synchronisation native réelle réussi.",

      engine_stage: "2/6",
      test: "real_native_sync_lab",
      notion_api_version: NOTION_VERSION,

      workspace: {
        id: connection.workspace_id,
        name:
          connection.workspace_name || null,
      },

      master: {
        template_key:
          official.template_key,
        name:
          official.notion_template_name,
        template_id:
          masterTemplate.id,
        official_version:
          official.official_version,
        fingerprint:
          masterFingerprint,
        snapshot:
          masterSnapshot,
      },

      laboratory_target: {
        name: labTemplate.name,
        template_id: labTemplate.id,

        before: {
          fingerprint:
            labBeforeFingerprint,
          snapshot:
            labBeforeSnapshot,
        },

        after: {
          fingerprint:
            stabilization.fingerprint,
          snapshot:
            stabilization.snapshot,
        },
      },

      verification: {
        final_matches_official:
          stabilization.fingerprint ===
          official.official_fingerprint,

        exact_master_fingerprint:
          stabilization.fingerprint ===
          masterFingerprint,

        target_remains_distinct_from_master:
          String(labTemplate.id).replace(/-/g, "") !==
          String(masterTemplate.id).replace(/-/g, ""),
      },

      native_apply: {
        accepted: true,
        erase_content: true,
        response_id:
          nativeApplyResponse?.id || null,
      },

      stabilization,

      safety: {
        target_is_laboratory_template: true,
        official_template_modified: false,
        neon_write_operations: 0,
        notion_write_operations: 1,
        pre_write_revalidation: true,
        automatic_sync_executed: true,
      },
    });
  } catch (error) {
    console.error(
      "Erreur test-sync-one-lab :",
      error
    );

    return res
      .status(error.statusCode || 500)
      .json({
        ok: false,
        engine_stage: "2/6",
        error:
          error.message ||
          "Erreur interne du serveur.",
      });
  }
}
