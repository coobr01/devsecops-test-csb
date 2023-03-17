const express = require("express");
// ---
const {
  axiosFormio,
  formioProjectUrl,
  formioApplicationFormPath,
  formioPaymentRequestFormPath,
} = require("../config/formio");
const { getSamEntities } = require("../utilities/bap");

const router = express.Router();

router.get("/app", (req, res) => {
  return res.json({ status: true });
});

router.get("/bap-sam-data", (req, res) => {
  getSamEntities(req, "bap.sam.data.status@erg.com")
    .then((bapRes) => {
      if (!Array.isArray(bapRes)) {
        throw Error();
      }

      return res.json({ status: true });
    })
    .catch(() => {
      return res.json({ status: false });
    });
});

const applicationFormApiPath = `${formioProjectUrl}/${formioApplicationFormPath}`;
const paymentRequestFormApiPath = `${formioProjectUrl}/${formioPaymentRequestFormPath}`;

router.get("/formio-application-schema", (req, res) => {
  axiosFormio(req)
    .get(applicationFormApiPath)
    .then((axiosRes) => axiosRes.data)
    .then((schema) => {
      // Verify that schema has type of form and a title exists (confirming formio returned a valid schema)
      return res.json({ status: schema.type === "form" && !!schema.title });
    })
    .catch(() => {
      return res.json({ status: false });
    });
});

router.get("/formio-payment-request-schema", (req, res) => {
  axiosFormio(req)
    .get(paymentRequestFormApiPath)
    .then((axiosRes) => axiosRes.data)
    .then((schema) => {
      // Verify that schema has type of form and a title exists (confirming formio returned a valid schema)
      return res.json({ status: schema.type === "form" && !!schema.title });
    })
    .catch(() => {
      return res.json({ status: false });
    });
});

module.exports = router;
