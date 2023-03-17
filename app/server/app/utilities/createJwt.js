const jwt = require("jsonwebtoken");
const jwtAlgorithm = process.env.NODE_ENV === "development" ? "HS256" : "RS256";

const createJwt = (userObject) => {
  return jwt.sign(
    {
      mail: userObject.mail,
      memberof: userObject.memberof || "",
      nameID: userObject.nameID,
      nameIDFormat: userObject.nameIDFormat,
      nameQualifier: userObject.nameQualifier,
      spNameQualifier: userObject.spNameQualifier,
      sessionIndex: userObject.sessionIndex,
    },
    process.env.JWT_PRIVATE_KEY,
    {
      algorithm: jwtAlgorithm,
      expiresIn: process.env.JWT_EXPIRE || "15m",
    }
  );
};

module.exports = { createJwt, jwtAlgorithm };
