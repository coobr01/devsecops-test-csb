const { resolve } = require("node:path");
const { readFile } = require("node:fs/promises");
const express = require("express");
const axios = require("axios").default || require("axios"); // TODO: https://github.com/axios/axios/issues/5011
const ObjectId = require("mongodb").ObjectId;
// ---
const {
  axiosFormio,
  formioProjectUrl,
  formioApplicationFormPath,
  formioPaymentRequestFormPath,
  formioCsbMetadata,
} = require("../config/formio");
const {
  ensureAuthenticated,
  ensureHelpdesk,
  storeBapComboKeys,
  verifyMongoObjectId,
} = require("../middleware");
const {
  getSamEntities,
  getBapFormSubmissionsStatuses,
  getBapApplicationSubmission,
} = require("../utilities/bap");
const log = require("../utilities/logger");

const applicationFormOpen = process.env.CSB_APPLICATION_FORM_OPEN === "true";
const paymentRequestFormOpen =
  process.env.CSB_PAYMENT_REQUEST_FORM_OPEN === "true";
const closeOutFormOpen = process.env.CSB_CLOSE_OUT_FORM_OPEN === "true";

const applicationFormApiPath = `${formioProjectUrl}/${formioApplicationFormPath}`;
const paymentRequestFormApiPath = `${formioProjectUrl}/${formioPaymentRequestFormPath}`;

/**
 * Returns a resolved or rejected promise, depending on if the given form's
 * submission period is open (as set via environment variables), and if the form
 * submission has the status of "Edits Requested" or not (as stored in and
 * returned from the BAP).
 * @param {Object} param
 * @param {'application'|'payment-request'|'close-out'} param.formType
 * @param {string} param.mongoId
 * @param {string} param.comboKey
 * @param {express.Request} param.req
 */
function checkFormSubmissionPeriodAndBapStatus({
  formType,
  mongoId,
  comboKey,
  req,
}) {
  // form submission period is open, so continue
  if (
    (formType === "application" && applicationFormOpen) ||
    (formType === "payment-request" && paymentRequestFormOpen) ||
    (formType === "close-out" && closeOutFormOpen)
  ) {
    return Promise.resolve();
  }

  // form submission period is closed, so only continue if edits are requested
  return getBapFormSubmissionsStatuses(req, [comboKey]).then((submissions) => {
    const submission = submissions.find((s) => s.CSB_Form_ID__c === mongoId);

    const statusField =
      formType === "application"
        ? "CSB_Funding_Request_Status__c"
        : formType === "payment-request"
        ? "CSB_Payment_Request_Status__c"
        : formType === "close-out"
        ? "CSB_Closeout_Request_Status__c"
        : null;

    return submission?.Parent_CSB_Rebate__r?.[statusField] === "Edits Requested"
      ? Promise.resolve()
      : Promise.reject();
  });
}

const router = express.Router();

// --- get static content from S3
router.get("/content", (req, res) => {
  const s3Bucket = process.env.S3_PUBLIC_BUCKET;
  const s3Region = process.env.S3_PUBLIC_REGION;

  // NOTE: static content files found in `app/server/app/content/` directory
  const filenames = [
    "site-alert.md",
    "helpdesk-intro.md",
    "all-rebates-intro.md",
    "all-rebates-outro.md",
    "new-application-dialog.md",
    "draft-application-intro.md",
    "submitted-application-intro.md",
    "draft-payment-request-intro.md",
    "submitted-payment-request-intro.md",
  ];

  const s3BucketUrl = `https://${s3Bucket}.s3-${s3Region}.amazonaws.com`;

  Promise.all(
    filenames.map((filename) => {
      // local development: read files directly from disk
      // Cloud.gov: fetch files from the public s3 bucket
      return process.env.NODE_ENV === "development"
        ? readFile(resolve(__dirname, "../content", filename), "utf8")
        : axios.get(`${s3BucketUrl}/content/${filename}`);
    })
  )
    .then((stringsOrResponses) => {
      // local development: no further processing of strings needed
      // Cloud.gov: get data from responses
      return process.env.NODE_ENV === "development"
        ? stringsOrResponses
        : stringsOrResponses.map((axiosRes) => axiosRes.data);
    })
    .then((data) => {
      return res.json({
        siteAlert: data[0],
        helpdeskIntro: data[1],
        allRebatesIntro: data[2],
        allRebatesOutro: data[3],
        newApplicationDialog: data[4],
        draftApplicationIntro: data[5],
        submittedApplicationIntro: data[6],
        draftPaymentRequestIntro: data[7],
        submittedPaymentRequestIntro: data[8],
      });
    })
    .catch((error) => {
      if (typeof error.toJSON === "function") {
        log({ level: "debug", message: error.toJSON(), req });
      }

      const errorStatus = error.response?.status;
      const errorMethod = error.response?.config?.method?.toUpperCase();
      const errorUrl = error.response?.config?.url;
      const message = `S3 Error: ${errorStatus} ${errorMethod} ${errorUrl}`;
      log({ level: "error", message, req });

      return res
        .status(error?.response?.status || 500)
        .json({ message: "Error getting static content from S3 bucket" });
    });
});

router.use(ensureAuthenticated);

// --- verification used to check if user has access to the /helpdesk route (using ensureHelpdesk middleware)
router.get("/helpdesk-access", ensureHelpdesk, (req, res) => {
  res.sendStatus(200);
});

// --- get CSB app specific data (open enrollment status, etc.)
router.get("/csb-data", (req, res) => {
  return res.json({
    submissionPeriodOpen: {
      application: applicationFormOpen,
      paymentRequest: paymentRequestFormOpen,
      closeOut: closeOutFormOpen,
    },
  });
});

// --- get user data from EPA Gateway/Login.gov
router.get("/epa-user-data", (req, res) => {
  const { mail, memberof, exp } = req.user;
  return res.json({ mail, memberof, exp });
});

// --- get user's SAM.gov data from EPA's Business Automation Platform (BAP)
router.get("/bap-sam-data", (req, res) => {
  getSamEntities(req, req.user.mail)
    .then((entities) => {
      // NOTE: allow admin or helpdesk users access to the app, even without SAM.gov data
      const userRoles = req.user.memberof.split(",");
      const helpdeskUser =
        userRoles.includes("csb_admin") || userRoles.includes("csb_helpdesk");

      if (!helpdeskUser && entities?.length === 0) {
        const message = `User with email ${req.user.mail} tried to use app without any associated SAM records.`;
        log({ level: "error", message, req });
        return res.json({ results: false, entities: [] });
      }

      return res.json({ results: true, entities });
    })
    .catch((error) => {
      const message = `Error getting SAM.gov data from BAP`;
      return res.status(401).json({ message });
    });
});

// --- get user's form submissions statuses from EPA's BAP
router.get("/bap-form-submissions", storeBapComboKeys, (req, res) => {
  return getBapFormSubmissionsStatuses(req, req.bapComboKeys)
    .then((submissions) => res.json(submissions))
    .catch((error) => {
      const message = `Error getting form submissions statuses from BAP`;
      return res.status(401).json({ message });
    });
});

// --- get user's Application form submissions from Forms.gov
router.get("/formio-application-submissions", storeBapComboKeys, (req, res) => {
  // NOTE: Helpdesk users might not have any SAM.gov records associated with
  // their email address so we should not return any submissions to those users.
  // The only reason we explicitly need to do this is because there could be
  // some submissions without `bap_hidden_entity_combo_key` field values in the
  // Forms.gov database – that will never be the case for submissions created
  // from this app, but there could be submissions created externally if someone
  // is testing posting data (e.g. from a REST client, or the Formio Viewer)
  if (req.bapComboKeys.length === 0) return res.json([]);

  const userSubmissionsUrl =
    `${applicationFormApiPath}/submission` +
    `?sort=-modified` +
    `&limit=1000000` +
    `&data.bap_hidden_entity_combo_key=` +
    `${req.bapComboKeys.join("&data.bap_hidden_entity_combo_key=")}`;

  axiosFormio(req)
    .get(userSubmissionsUrl)
    .then((axiosRes) => axiosRes.data)
    .then((submissions) => res.json(submissions))
    .catch((error) => {
      const message = `Error getting Forms.gov Application form submissions`;
      return res.status(error?.response?.status || 500).json({ message });
    });
});

// --- post a new Application form submission to Forms.gov
router.post("/formio-application-submission", storeBapComboKeys, (req, res) => {
  const comboKey = req.body.data?.bap_hidden_entity_combo_key;

  if (!applicationFormOpen) {
    const message = `CSB Application form enrollment period is closed`;
    return res.status(400).json({ message });
  }

  // verify post data includes one of user's BAP combo keys
  if (!req.bapComboKeys.includes(comboKey)) {
    const message = `User with email ${req.user.mail} attempted to post a new Application form submission without a matching BAP combo key`;
    log({ level: "error", message, req });
    return res.status(401).json({ message: "Unauthorized" });
  }

  // add custom metadata to track formio submissions from wrapper
  req.body.metadata = {
    ...formioCsbMetadata,
  };

  axiosFormio(req)
    .post(`${applicationFormApiPath}/submission`, req.body)
    .then((axiosRes) => axiosRes.data)
    .then((submission) => res.json(submission))
    .catch((error) => {
      const message = `Error posting Forms.gov Application form submission`;
      return res.status(error?.response?.status || 500).json({ message });
    });
});

// --- get an existing Application form's schema and submission data from Forms.gov
router.get(
  "/formio-application-submission/:mongoId",
  verifyMongoObjectId,
  storeBapComboKeys,
  (req, res) => {
    const { mongoId } = req.params;

    Promise.all([
      axiosFormio(req).get(`${applicationFormApiPath}/submission/${mongoId}`),
      axiosFormio(req).get(applicationFormApiPath),
    ])
      .then((axiosResponses) => axiosResponses.map((axiosRes) => axiosRes.data))
      .then(([submission, schema]) => {
        const comboKey = submission.data.bap_hidden_entity_combo_key;

        if (!req.bapComboKeys.includes(comboKey)) {
          const message = `User with email ${req.user.mail} attempted to access Application form submission ${mongoId} that they do not have access to.`;
          log({ level: "warn", message, req });
          return res.json({
            userAccess: false,
            formSchema: null,
            submission: null,
          });
        }

        return res.json({
          userAccess: true,
          formSchema: { url: applicationFormApiPath, json: schema },
          submission,
        });
      })
      .catch((error) => {
        const message = `Error getting Forms.gov Application form submission ${mongoId}`;
        res.status(error?.response?.status || 500).json({ message });
      });
  }
);

// --- post an update to an existing draft Application form submission to Forms.gov
router.post(
  "/formio-application-submission/:mongoId",
  verifyMongoObjectId,
  storeBapComboKeys,
  (req, res) => {
    const { mongoId } = req.params;
    const submission = req.body;
    const comboKey = submission.data?.bap_hidden_entity_combo_key;
    const formType = "application";

    checkFormSubmissionPeriodAndBapStatus({ formType, mongoId, comboKey, req })
      .then(() => {
        // verify post data includes one of user's BAP combo keys
        if (!req.bapComboKeys.includes(comboKey)) {
          const message = `User with email ${req.user.mail} attempted to update Application form submission ${mongoId} without a matching BAP combo key`;
          log({ level: "error", message, req });
          return res.status(401).json({ message: "Unauthorized" });
        }

        // add custom metadata to track formio submissions from wrapper
        submission.metadata = {
          ...submission.metadata,
          ...formioCsbMetadata,
        };

        axiosFormio(req)
          .put(`${applicationFormApiPath}/submission/${mongoId}`, submission)
          .then((axiosRes) => axiosRes.data)
          .then((submission) => res.json(submission))
          .catch((error) => {
            const message = `Error updating Forms.gov Application form submission ${mongoId}`;
            return res.status(error?.response?.status || 500).json({ message });
          });
      })
      .catch((error) => {
        const message = `CSB Application form enrollment period is closed`;
        return res.status(400).json({ message });
      });
  }
);

// --- upload s3 file metadata to Forms.gov
router.post(
  "/s3/:formType/:mongoId/:comboKey/storage/s3",
  storeBapComboKeys,
  (req, res) => {
    const { formType, mongoId, comboKey } = req.params;

    checkFormSubmissionPeriodAndBapStatus({ formType, mongoId, comboKey, req })
      .then(() => {
        if (!req.bapComboKeys.includes(comboKey)) {
          const message = `User with email ${req.user.mail} attempted to upload a file without a matching BAP combo key`;
          log({ level: "error", message, req });
          return res.status(401).json({ message: "Unauthorized" });
        }

        axiosFormio(req)
          .post(`${applicationFormApiPath}/storage/s3`, req.body)
          .then((axiosRes) => axiosRes.data)
          .then((fileMetadata) => res.json(fileMetadata))
          .catch((error) => {
            const message = `Error uploading Forms.gov file`;
            return res.status(error?.response?.status || 500).json({ message });
          });
      })
      .catch((error) => {
        const formName =
          formType === "application"
            ? "CSB Application"
              ? formType === "payment-request"
              : "CSB Payment Request"
              ? formType === "close-out"
              : "CSB Close-Out"
            : "CSB";
        const message = `${formName} form enrollment period is closed`;
        return res.status(400).json({ message });
      });
  }
);

// --- download s3 file metadata from Forms.gov
router.get(
  "/s3/:formType/:mongoId/:comboKey/storage/s3",
  storeBapComboKeys,
  (req, res) => {
    const { comboKey } = req.params;

    if (!req.bapComboKeys.includes(comboKey)) {
      const message = `User with email ${req.user.mail} attempted to download a file without a matching BAP combo key`;
      log({ level: "error", message, req });
      return res.status(401).json({ message: "Unauthorized" });
    }

    axiosFormio(req)
      .get(`${applicationFormApiPath}/storage/s3`, { params: req.query })
      .then((axiosRes) => axiosRes.data)
      .then((fileMetadata) => res.json(fileMetadata))
      .catch((error) => {
        const message = `Error downloading Forms.gov file`;
        return res.status(error?.response?.status || 500).json({ message });
      });
  }
);

// --- get user's Payment Request form submissions from Forms.gov
router.get(
  "/formio-payment-request-submissions",
  storeBapComboKeys,
  (req, res) => {
    const userSubmissionsUrl =
      `${paymentRequestFormApiPath}/submission` +
      `?sort=-modified` +
      `&limit=1000000` +
      `&data.bap_hidden_entity_combo_key=${req.bapComboKeys.join(
        "&data.bap_hidden_entity_combo_key="
      )}`;

    axiosFormio(req)
      .get(userSubmissionsUrl)
      .then((axiosRes) => axiosRes.data)
      .then((submissions) => res.json(submissions))
      .catch((error) => {
        const message = `Error getting Forms.gov Payment Request form submissions`;
        return res.status(error?.response?.status || 500).json({ message });
      });
  }
);

// --- post a new Payment Request form submission to Forms.gov
router.post(
  "/formio-payment-request-submission",
  storeBapComboKeys,
  (req, res) => {
    const {
      email,
      title,
      name,
      entity,
      comboKey,
      rebateId,
      reviewItemId,
      applicationFormModified,
    } = req.body;

    // verify post data includes one of user's BAP combo keys
    if (!req.bapComboKeys.includes(comboKey)) {
      const message = `User with email ${req.user.mail} attempted to post a new Payment Request form submission without a matching BAP combo key`;
      log({ level: "error", message, req });
      return res.status(401).json({ message: "Unauthorized" });
    }

    const {
      UNIQUE_ENTITY_ID__c,
      ENTITY_EFT_INDICATOR__c,
      ELEC_BUS_POC_EMAIL__c,
      ALT_ELEC_BUS_POC_EMAIL__c,
      GOVT_BUS_POC_EMAIL__c,
      ALT_GOVT_BUS_POC_EMAIL__c,
    } = entity;

    return getBapApplicationSubmission(req, reviewItemId)
      .then(({ formsTableRecordQuery, busTableRecordsQuery }) => {
        const {
          CSB_NCES_ID__c,
          Primary_Applicant__r,
          Alternate_Applicant__r,
          Applicant_Organization__r,
          CSB_School_District__r,
          Fleet_Name__c,
          School_District_Prioritized__c,
          Total_Rebate_Funds_Requested__c,
          Total_Infrastructure_Funds__c,
        } = formsTableRecordQuery[0];

        const busInfo = busTableRecordsQuery.map((record) => ({
          busNum: record.Rebate_Item_num__c,
          oldBusNcesDistrictId: CSB_NCES_ID__c,
          oldBusVin: record.CSB_VIN__c,
          oldBusModelYear: record.CSB_Model_Year__c,
          oldBusFuelType: record.CSB_Fuel_Type__c,
          newBusFuelType: record.CSB_Replacement_Fuel_Type__c,
          hidden_bap_max_rebate: record.CSB_Funds_Requested__c,
        }));

        // NOTE: `purchaseOrders` is initialized as an empty array to fix some
        // issue with the field being changed to an object when the form loads
        const submission = {
          data: {
            bap_hidden_entity_combo_key: comboKey,
            hidden_application_form_modified: applicationFormModified,
            hidden_current_user_email: email,
            hidden_current_user_title: title,
            hidden_current_user_name: name,
            hidden_sam_uei: UNIQUE_ENTITY_ID__c,
            hidden_sam_efti: ENTITY_EFT_INDICATOR__c || "0000",
            hidden_sam_elec_bus_poc_email: ELEC_BUS_POC_EMAIL__c,
            hidden_sam_alt_elec_bus_poc_email: ALT_ELEC_BUS_POC_EMAIL__c,
            hidden_sam_govt_bus_poc_email: GOVT_BUS_POC_EMAIL__c,
            hidden_sam_alt_govt_bus_poc_email: ALT_GOVT_BUS_POC_EMAIL__c,
            hidden_bap_rebate_id: rebateId,
            hidden_bap_district_id: CSB_NCES_ID__c,
            hidden_bap_primary_name: Primary_Applicant__r?.Name,
            hidden_bap_primary_title: Primary_Applicant__r?.Title,
            hidden_bap_primary_phone_number: Primary_Applicant__r?.Phone,
            hidden_bap_primary_email: Primary_Applicant__r?.Email,
            hidden_bap_alternate_name: Alternate_Applicant__r?.Name || "",
            hidden_bap_alternate_title: Alternate_Applicant__r?.Title || "",
            hidden_bap_alternate_phone_number:
              Alternate_Applicant__r?.Phone || "",
            hidden_bap_alternate_email: Alternate_Applicant__r?.Email || "",
            hidden_bap_org_name: Applicant_Organization__r?.Name,
            hidden_bap_district_name: CSB_School_District__r?.Name,
            hidden_bap_fleet_name: Fleet_Name__c,
            hidden_bap_prioritized: School_District_Prioritized__c,
            hidden_bap_requested_funds: Total_Rebate_Funds_Requested__c,
            hidden_bap_infra_max_rebate: Total_Infrastructure_Funds__c,
            busInfo,
            purchaseOrders: [],
          },
          // add custom metadata to track formio submissions from wrapper
          metadata: {
            ...formioCsbMetadata,
          },
          state: "draft",
        };

        axiosFormio(req)
          .post(`${paymentRequestFormApiPath}/submission`, submission)
          .then((axiosRes) => axiosRes.data)
          .then((submission) => res.json(submission))
          .catch((error) => {
            const message = `Error posting Forms.gov Payment Request form submission`;
            return res.status(error?.response?.status || 500).json({ message });
          });
      })
      .catch((error) => {
        const message = `Error getting Application form submission from BAP`;
        return res.status(401).json({ message });
      });
  }
);

// --- get an existing Payment Request form's schema and submission data from Forms.gov
router.get(
  "/formio-payment-request-submission/:rebateId",
  storeBapComboKeys,
  async (req, res) => {
    const { rebateId } = req.params; // CSB Rebate ID (6 digits)

    const matchedPaymentRequestFormSubmissions =
      `${paymentRequestFormApiPath}/submission` +
      `?data.hidden_bap_rebate_id=${rebateId}` +
      `&select=_id,data.bap_hidden_entity_combo_key`;

    Promise.all([
      axiosFormio(req).get(matchedPaymentRequestFormSubmissions),
      axiosFormio(req).get(paymentRequestFormApiPath),
    ])
      .then((axiosResponses) => axiosResponses.map((axiosRes) => axiosRes.data))
      .then(([submissions, schema]) => {
        const submission = submissions[0];
        const mongoId = submission._id;
        const comboKey = submission.data.bap_hidden_entity_combo_key;

        if (!req.bapComboKeys.includes(comboKey)) {
          const message = `User with email ${req.user.mail} attempted to access Payment Request form submission ${rebateId} that they do not have access to.`;
          log({ level: "warn", message, req });
          return res.json({
            userAccess: false,
            formSchema: null,
            submission: null,
          });
        }

        // NOTE: verifyMongoObjectId middleware content:
        if (mongoId && !ObjectId.isValid(mongoId)) {
          const message = `MongoDB ObjectId validation error for: ${mongoId}`;
          return res.status(400).json({ message });
        }

        // NOTE: We can't just use the returned submission data here because
        // Formio returns the string literal 'YES' instead of a base64 encoded
        // image string for signature fields when you query for all submissions
        // matching on a field's value (`/submission?data.hidden_bap_rebate_id=${rebateId}`).
        // We need to query for a specific submission (e.g. `/submission/${mongoId}`),
        // to have Formio return the correct signature field data.
        axiosFormio(req)
          .get(`${paymentRequestFormApiPath}/submission/${mongoId}`)
          .then((axiosRes) => axiosRes.data)
          .then((submission) => {
            return res.json({
              userAccess: true,
              formSchema: { url: paymentRequestFormApiPath, json: schema },
              submission,
            });
          });
      })
      .catch((error) => {
        const message = `Error getting Forms.gov Payment Request form submission ${rebateId}`;
        res.status(error?.response?.status || 500).json({ message });
      });
  }
);

// --- post an update to an existing draft Payment Request form submission to Forms.gov
router.post(
  "/formio-payment-request-submission/:rebateId",
  storeBapComboKeys,
  (req, res) => {
    const { rebateId } = req.params; // CSB Rebate ID (6 digits)
    const { mongoId, submission } = req.body;
    const comboKey = submission.data?.bap_hidden_entity_combo_key;
    const formType = "payment-request";

    checkFormSubmissionPeriodAndBapStatus({ formType, mongoId, comboKey, req })
      .then(() => {
        // verify post data includes one of user's BAP combo keys
        if (!req.bapComboKeys.includes(comboKey)) {
          const message = `User with email ${req.user.mail} attempted to update Payment Request form submission ${rebateId} without a matching BAP combo key`;
          log({ level: "error", message, req });
          return res.status(401).json({ message: "Unauthorized" });
        }

        // NOTE: verifyMongoObjectId middleware content:
        if (mongoId && !ObjectId.isValid(mongoId)) {
          const message = `MongoDB ObjectId validation error for: ${mongoId}`;
          return res.status(400).json({ message });
        }

        // add custom metadata to track formio submissions from wrapper
        submission.metadata = {
          ...submission.metadata,
          ...formioCsbMetadata,
        };

        axiosFormio(req)
          .put(`${paymentRequestFormApiPath}/submission/${mongoId}`, submission)
          .then((axiosRes) => axiosRes.data)
          .then((submission) => res.json(submission))
          .catch((error) => {
            const message = `Error updating Forms.gov Payment Request form submission ${rebateId}`;
            return res.status(error?.response?.status || 500).json({ message });
          });
      })
      .catch((error) => {
        const message = `CSB Payment Request form enrollment period is closed`;
        return res.status(400).json({ message });
      });
  }
);

// --- delete an existing Payment Request form submission from Forms.gov
router.post(
  "/delete-formio-payment-request-submission",
  storeBapComboKeys,
  (req, res) => {
    const { mongoId, rebateId, comboKey } = req.body;

    // verify post data includes one of user's BAP combo keys
    if (!req.bapComboKeys.includes(comboKey)) {
      const message = `User with email ${req.user.mail} attempted to delete Payment Request form submission ${rebateId} without a matching BAP combo key`;
      log({ level: "error", message, req });
      return res.status(401).json({ message: "Unauthorized" });
    }

    // ensure the BAP status of the corresponding Application form submission
    // is "Edits Requested" before deleting the Payment Request form submission
    // from Forms.gov
    getBapFormSubmissionsStatuses(req, req.bapComboKeys)
      .then((submissions) => {
        const application = submissions.find((submission) => {
          return (
            submission.Parent_Rebate_ID__c === rebateId &&
            submission.Record_Type_Name__c === "CSB Funding Request"
          );
        });

        const applicationNeedsEdits =
          application?.Parent_CSB_Rebate__r.CSB_Funding_Request_Status__c ===
          "Edits Requested";

        if (!applicationNeedsEdits) {
          const message = `CSB Application form submission does not need edits`;
          return res.status(400).json({ message });
        }

        axiosFormio(req)
          .delete(`${paymentRequestFormApiPath}/submission/${mongoId}`)
          .then((axiosRes) => axiosRes.data)
          .then((response) => {
            const message = `User with email ${req.user.mail} successfully deleted Payment Request form submission ${rebateId}`;
            log({ level: "info", message, req });

            res.json(response);
          })
          .catch((error) => {
            const message = `Error deleting Forms.gov Payment Request form submission ${rebateId}`;
            return res.status(error?.response?.status || 500).json({ message });
          });
      })
      .catch((error) => {
        const message = `Error getting form submissions statuses from BAP`;
        return res.status(401).json({ message });
      });
  }
);

module.exports = router;
