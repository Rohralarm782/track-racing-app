import { Request, Response, NextFunction } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;

  if (!token || token !== process.env.ADMIN_PASSWORD) {
    res.status(401).json({ error: 'Nicht autorisiert' });
    return;
  }
  next();
}
