const passport = require('passport');
const UsersService = require('./users');
const SettingsService = require('./settings');
const TokensService = require('./tokens');
const fetch = require('node-fetch');
const FormData = require('form-data');
const JWT = require('jsonwebtoken');
const LocalStrategy = require('passport-local').Strategy;
const errors = require('../errors');
const uuid = require('uuid');
const debug = require('debug')('talk:services:passport');
const {createClient} = require('./redis');
const bowser = require('bowser');
const ms = require('ms');

// Create a redis client to use for authentication.
const client = createClient();

const {
  JWT_SECRET,
  JWT_ISSUER,
  JWT_EXPIRY,
  JWT_AUDIENCE,
  RECAPTCHA_SECRET,
  RECAPTCHA_ENABLED
} = require('../config');

// GenerateToken will sign a token to include all the authorization information
// needed for the front end.
const GenerateToken = (user) => JWT.sign({}, JWT_SECRET, {
  jwtid: uuid.v4(),
  expiresIn: JWT_EXPIRY,
  issuer: JWT_ISSUER,
  subject: user.id,
  audience: JWT_AUDIENCE
});

// SetTokenForSafari sends the token in a cookie for Safari clients.
const SetTokenForSafari = (req, res, token) => {
  const browser = bowser._detect(req.headers['user-agent']);
  if (browser.ios || browser.safari) {
    res.cookie('authorization', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      expires: new Date(Date.now() + ms(JWT_EXPIRY))
    });
  }
};

// HandleGenerateCredentials validates that an authentication scheme did indeed
// return a user, if it did, then sign and return the user and token to be used
// by the frontend to display and update the UI.
const HandleGenerateCredentials = (req, res, next) => (err, user) => {
  if (err) {
    return next(err);
  }

  if (!user) {
    return next(errors.ErrNotAuthorized);
  }

  // Generate the token to re-issue to the frontend.
  const token = GenerateToken(user);

  SetTokenForSafari(req, res, token);

  // Send back the details!
  res.json({user, token});
};

/**
 * Returns the response to the login attempt via a popup callback with some JS.
 */
const HandleAuthPopupCallback = (req, res, next) => (err, user) => {
  if (err) {
    return res.render('auth-callback', {auth: JSON.stringify({err, data: null})});
  }

  if (!user) {
    return res.render('auth-callback', {auth: JSON.stringify({err: errors.ErrNotAuthorized, data: null})});
  }

  // Generate the token to re-issue to the frontend.
  const token = GenerateToken(user);

  SetTokenForSafari(req, res, token);

  // We logged in the user! Let's send back the user data.
  res.render('auth-callback', {auth: JSON.stringify({err: null, data: {user, token}})});
};

/**
 * Validates that a user is allowed to login.
 * @param {User}     user the user to be validated
 * @param {Function} done the callback for the validation
 */
function ValidateUserLogin(loginProfile, user, done) {
  if (!user) {
    return done(new Error('user not found'));
  }

  if (user.disabled) {
    return done(new errors.ErrAuthentication('Account disabled'));
  }

  // If the user isn't a local user (i.e., a social user).
  if (loginProfile.provider !== 'local') {
    return done(null, user);
  }

  // The user is a local user, check if we need email confirmation.
  return SettingsService.retrieve().then(({requireEmailConfirmation = false}) => {

    // If we have the requirement of checking that emails for users are
    // verified, then we need to check the email address to ensure that it has
    // been verified.
    if (requireEmailConfirmation) {

      // Get the profile representing the local account.
      let profile = user.profiles.find((profile) => profile.id === loginProfile.id);

      // This should never get to this point, if it does, don't let this past.
      if (!profile) {
        throw new Error('ID indicated by loginProfile is not on user object');
      }

      // If the profile doesn't have a metadata field, or it does not have a
      // confirmed_at field, or that field is null, then send them back.
      if (!profile.metadata || !profile.metadata.confirmed_at || profile.metadata.confirmed_at === null) {
        return done(new errors.ErrAuthentication(loginProfile.id));
      }
    }

    return done(null, user);
  });
}

//==============================================================================
// JWT STRATEGY
//==============================================================================

/**
 * Revoke the token on the request.
 */
const HandleLogout = (req, res, next) => {
  const {jwt} = req;

  const now = new Date();
  const expiry = (jwt.exp - now.getTime() / 1000).toFixed(0);

  client.set(`jtir[${jwt.jti}]`, now.toISOString(), 'EX', expiry, (err) => {
    if (err) {
      return next(err);
    }

    res.clearCookie('authorization');
    res.status(204).end();
  });
};

const checkGeneralTokenBlacklist = (jwt) => new Promise((resolve, reject) => {
  client.get(`jtir[${jwt.jti}]`, (err, expiry) => {
    if (err) {
      return reject(err);
    }

    if (expiry != null) {
      return reject(new errors.ErrAuthentication('token was revoked'));
    }

    return resolve();
  });
});

/**
 * Check if the given token is already blacklisted, throw an error if it is.
 */
const CheckBlacklisted = async (jwt) => {

  // Check to see if this is a PAT.
  if (jwt.pat) {
    return TokensService.validate(jwt.sub, jwt.jti);
  }

  // It wasn't a PAT! Check to see if it is valid anyways.
  return checkGeneralTokenBlacklist(jwt);
};

const jwt = require('jsonwebtoken');
const JwtStrategy = require('passport-jwt').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;

let cookieExtractor = function(req) {
  let token = null;

  if (req && req.cookies) {
    token = req.cookies['authorization'];
  }

  return token;
};

// Override the JwtVerifier method on the JwtStrategy so we can pack the
// original token into the payload.
JwtStrategy.JwtVerifier = (token, secretOrKey, options, callback) => {
  return jwt.verify(token, secretOrKey, options, (err, jwt) => {
    if (err) {
      return callback(err);
    }

    // Attach the original token onto the payload.
    return callback(false, {token, jwt});
  });
};

// Extract the JWT from the 'Authorization' header with the 'Bearer' scheme.
passport.use(new JwtStrategy({

  // Prepare the extractor from the header.
  jwtFromRequest: ExtractJwt.fromExtractors([
    cookieExtractor,
    ExtractJwt.fromAuthHeaderWithScheme('Bearer')
  ]),

  // Use the secret passed in which is loaded from the environment. This can be
  // a certificate (loaded) or a HMAC key.
  secretOrKey: JWT_SECRET,

  // Verify the issuer.
  issuer: JWT_ISSUER,

  // Verify the audience.
  audience: JWT_AUDIENCE,

  // Enable only the HS256 algorithm.
  algorithms: ['HS256'],

  // Pass the request object back to the callback so we can attach the JWT to
  // it.
  passReqToCallback: true
}, async (req, {token, jwt}, done) => {

  // Load the user from the environment, because we just got a user from the
  // header.
  try {

    // Check to see if the token has been revoked
    await CheckBlacklisted(jwt);

    // Try to get the user from the database or crack it from the token and
    // plugin integrations.
    let user = await UsersService.findOrCreateByIDToken(jwt.sub, {token, jwt});

    // Attach the JWT to the request.
    req.jwt = jwt;

    return done(null, user);
  } catch(e) {
    return done(e);
  }
}));

//==============================================================================
// LOCAL STRATEGY
//==============================================================================

/**
 * This looks at the request headers to see if there is a recaptcha response on
 * the input request.
 */
const CheckIfRecaptcha = (req) => {
  let response = req.get('X-Recaptcha-Response');

  if (response && response.length > 0) {
    return true;
  }

  return false;
};

/**
 * This checks the user to see if the current email profile needs to get checked
 * for recaptcha compliance before being allowed to login.
 */
const CheckIfNeedsRecaptcha = (user, email) => {

  // Get the profile representing the local account.
  let profile = user.profiles.find((profile) => profile.id === email);

  // This should never get to this point, if it does, don't let this past.
  if (!profile) {
    throw new Error('ID indicated by loginProfile is not on user object');
  }

  if (profile.metadata && profile.metadata.recaptcha_required) {
    return true;
  }

  return false;
};

/**
 * This sends the request details down Google to check to see if the response is
 * genuine or not.
 * @return {Promise} resolves with the success status of the recaptcha
 */
const CheckRecaptcha = async (req) => {

  // Ask Google to verify the recaptcha response: https://developers.google.com/recaptcha/docs/verify
  const form = new FormData();

  form.append('secret', RECAPTCHA_SECRET);
  form.append('response', req.get('X-Recaptcha-Response'));
  form.append('remoteip', req.ip);

  // Perform the request.
  let res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    body: form,
    headers: form.getHeaders()
  });

  // Parse the JSON response.
  let json = await res.json();

  return json.success;
};

/**
 * This records a login attempt failure as well as optionally flags an account
 * for requiring a recaptcha in the future outside the temporary window.
 * @return {Promise} resolves with nothing if rate limit not exeeded, errors if
 *                   there is a rate limit error
 */
const HandleFailedAttempt = async (email, userNeedsRecaptcha) => {
  try {
    await UsersService.recordLoginAttempt(email);
  } catch (err) {
    if (err === errors.ErrLoginAttemptMaximumExceeded && !userNeedsRecaptcha && RECAPTCHA_ENABLED) {

      debug(`flagging user email=${email}`);
      await UsersService.flagForRecaptchaRequirement(email, true);
    }

    throw err;
  }
};

passport.use(new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password',
  passReqToCallback: true
}, async (req, email, password, done) => {

  // Normalize email
  email = email.toLowerCase();

  // We need to check if this request has a recaptcha on it at all, if it does,
  // we must verify it first. If verification fails, we fail the request early.
  // We can only do this obviously when recaptcha is enabled.
  let hasRecaptcha = CheckIfRecaptcha(req);
  let recaptchaPassed = false;
  if (RECAPTCHA_ENABLED && hasRecaptcha) {

    try {

      // Check to see if this recaptcha passed.
      recaptchaPassed = await CheckRecaptcha(req);
    } catch (err) {
      return done(err);
    }

    if (!recaptchaPassed) {
      try {
        await HandleFailedAttempt(email);
      } catch (err) {
        return done(err);
      }

      return done(null, false, {message: 'Incorrect recaptcha'});
    }
  }

  debug(`hasRecaptcha=${hasRecaptcha}, recaptchaPassed=${recaptchaPassed}`);

  // If the request didn't have a recaptcha, check to see if we did need one by
  // checking the rate limit against failed attempts on this email
  // address/login.
  if (!hasRecaptcha) {
    try {
      await UsersService.checkLoginAttempts(email);
    } catch (err) {
      if (err === errors.ErrLoginAttemptMaximumExceeded) {

        // This says, we didn't have a recaptcha, yet we needed one.. Reject
        // here.

        try {
          await HandleFailedAttempt(email);
        } catch (err) {
          return done(err);
        }

        return done(null, false, {message: 'Incorrect recaptcha'});
      }

      // Some other unexpected error occured.
      return done(err);
    }
  }

  // Let's find the user for which this login is connected to.
  let user;
  try {
    user = await UsersService.findLocalUser(email);
  } catch (err) {
    return done(err);
  }

  debug(`user=${user != null}`);

  // If the user doesn't exist, then mark this as a failed attempt at logging in
  // this non-existant user and continue.
  if (!user) {
    try {
      await HandleFailedAttempt(email);
    } catch (err) {
      return done(err);
    }

    return done(null, false, {message: 'Incorrect email/password combination'});
  }

  // Let's check if the user indeed needed recaptcha in order to authenticate.
  // We can only do this obviously when recaptcha is enabled.
  let userNeedsRecaptcha = false;
  if (RECAPTCHA_ENABLED && user) {
    userNeedsRecaptcha = CheckIfNeedsRecaptcha(user, email);
  }

  debug(`userNeedsRecaptcha=${userNeedsRecaptcha}`);

  // Let's check now if their password is correct.
  let userPasswordCorrect;
  try {
    userPasswordCorrect = await user.verifyPassword(password);
  } catch (err) {
    return done(err);
  }

  debug(`userPasswordCorrect=${userPasswordCorrect}`);

  // If their password wasn't correct, mark their attempt as failed and
  // continue.
  if (!userPasswordCorrect) {
    try {
      await HandleFailedAttempt(email, userNeedsRecaptcha);
    } catch (err) {
      return done(err);
    }

    return done(null, false, {message: 'Incorrect email/password combination'});
  }

  // If the user needed a recaptcha, yet we have gotten this far, this indicates
  // that the password was correct, so let's unflag their account for logins. We
  // can only do this obviously when recaptcha is enabled. The account wouldn't
  // have been flagged otherwise.
  if (RECAPTCHA_ENABLED && userNeedsRecaptcha) {
    try {
      await UsersService.flagForRecaptchaRequirement(email, false);
    } catch (err) {
      return done(err);
    }
  }

  // Define the loginProfile being used to perform an additional
  // verificaiton.
  let loginProfile = {id: email, provider: 'local'};

  // Perform final steps to login the user.
  return ValidateUserLogin(loginProfile, user, done);
}));

module.exports = {
  passport,
  ValidateUserLogin,
  HandleFailedAttempt,
  HandleAuthPopupCallback,
  HandleGenerateCredentials,
  HandleLogout,
  CheckBlacklisted
};
