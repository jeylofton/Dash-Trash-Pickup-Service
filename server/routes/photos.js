import { Router } from 'express';
import { one } from '../db/index.js';
import { requireAuth, mayViewPhoto } from '../lib/rbac.js';
import { storage } from '../lib/storage.js';

export const router = Router();

/* Photos are NOT served as static files. Every request is authorized
   individually, so a leaked URL is useless to anyone without permission. */
router.get('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad photo id.' });

  if (!mayViewPhoto(req.user, id)) {
    return res.status(404).json({ error: 'Not found.' });   // never confirm it exists
  }

  const photo = one('SELECT * FROM pickup_photos WHERE id = ?', id);
  if (!photo) return res.status(404).json({ error: 'Not found.' });

  try {
    const buffer = await storage.get(photo.storage_key);
    res.set('Content-Type', photo.mime_type || storage.contentTypeFor(photo.storage_key));
    res.set('Cache-Control', 'private, max-age=300');
    res.send(buffer);
  } catch (err) {
    console.error('[photos] read failed', photo.storage_key, err.message);
    res.status(404).json({ error: 'Photo file is missing.' });
  }
});
