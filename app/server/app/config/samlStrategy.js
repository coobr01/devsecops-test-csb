const { Strategy } = require("passport-saml");

const samlStrategy = new Strategy(
  {
    entryPoint: process.env.SAML_LOGIN_URL,
    logoutUrl: process.env.SAML_LOGOUT_URL,
    callbackUrl: `${process.env.SERVER_URL}/login/assert`,
    logoutCallbackUrl: `${process.env.SERVER_URL}/logout/callback`,
    issuer: process.env.SAML_ENTITY_ID,
    cert: process.env.SAML_IDP_CERT,
    privateKey: process.env.SAML_PRIVATE_KEY || null,
    signatureAlgorithm: "sha256",
    acceptedClockSkewMs: process.env.SAML_CLOCK_SKEW || 0,
    identifierFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
    disableRequestedAuthnContext: true,
  },
  // login
  function (profile, done) {
    return done(null, profile);
  }
);

module.exports = samlStrategy;
