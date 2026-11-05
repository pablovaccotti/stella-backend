// src/modules/whatsapp/controllers/webhook.controller.ts
import { Request, Response } from 'express';
import { createHmac } from 'crypto';
import { safeEqual } from '../../../utils/security';

let appSecretWarningShown = false;

export class WhatsAppWebhookController {
  // GET /webhook/whatsapp - Verificación del webhook (SOLO GET)
  static verifyWebhook(req: Request, res: Response): void {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;

    if (
      typeof mode !== 'string' ||
      typeof token !== 'string' ||
      typeof challenge !== 'string' ||
      !expectedToken ||
      mode !== 'subscribe' ||
      !safeEqual(token, expectedToken)
    ) {
      res.sendStatus(403);
      return;
    }

    res.status(200).type('text/plain').send(challenge);
  }

  // POST /webhook/whatsapp - Recepción de mensajes
  static async handleWebhook(req: Request, res: Response): Promise<void> {
    try {
      const appSecret = process.env.WHATSAPP_APP_SECRET;

      if (!appSecret) {
        if (!appSecretWarningShown) {
          console.warn('WHATSAPP_APP_SECRET no configurado: se omite la validación de firma');
          appSecretWarningShown = true;
        }
        res.sendStatus(200);
        return;
      }

      const signatureHeader = req.header('x-hub-signature-256');
      const rawBody = (req as any).rawBody;

      if (
        !signatureHeader ||
        !signatureHeader.startsWith('sha256=') ||
        !Buffer.isBuffer(rawBody)
      ) {
        res.sendStatus(401);
        return;
      }

      const receivedSignature = signatureHeader.slice('sha256='.length);
      const expectedSignature = createHmac('sha256', appSecret).update(rawBody).digest('hex');

      if (!safeEqual(receivedSignature, expectedSignature)) {
        res.sendStatus(401);
        return;
      }

      res.sendStatus(200);
    } catch (error) {
      console.error('Error en webhook de WhatsApp:', error);
      res.status(500).json({ success: false, error: 'Error interno' });
    }
  }
}
