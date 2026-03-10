const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, display_name: user.display_name },
    JWT_SECRET,
    { expiresIn: '365d' }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;

    // Auto-refresh: if token is older than 30 days, issue a new one in response header
    const tokenAge = Date.now() / 1000 - decoded.iat;
    if (tokenAge > 30 * 86400) {
      const newToken = generateToken(decoded);
      res.setHeader('X-Refreshed-Token', newToken);
    }

    next();
  } catch (err) {
    // If the token is expired but signature is valid, auto-renew silently
    // This prevents widget/client breakage when tokens expire
    if (err.name === 'TokenExpiredError') {
      try {
        const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
        req.user = decoded;
        const newToken = generateToken(decoded);
        res.setHeader('X-Refreshed-Token', newToken);
        next();
      } catch (innerErr) {
        return res.status(401).json({ error: 'Invalid token' });
      }
    } else {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }
}

module.exports = { generateToken, authMiddleware };
