import express, { NextFunction, Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createHmac } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import mercadopago from 'mercadopago';
import { WhatsAppWebhookController } from './modules/whatsapp/controllers/webhook.controller';
import { WhatsAppService } from './modules/whatsapp/services/whatsapp.service';
import { safeEqual } from './utils/security';

dotenv.config();

// ============================================================================
// Configuración obligatoria
// ============================================================================

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  return value;
}

const MP_ACCESS_TOKEN = requiredEnv('MP_ACCESS_TOKEN');
const BACKEND_URL = requiredEnv('BACKEND_URL').replace(/\/+$/, '');
const FRONTEND_URL = process.env.FRONTEND_URL;
const MP_SANDBOX = process.env.MP_SANDBOX === 'true';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const TEST_PAYER_EMAIL = 'cliente_stella_test@test.com';

const prisma = new PrismaClient();

mercadopago.configure({
  access_token: MP_ACCESS_TOKEN
});

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());

app.use(
  express.json({
    limit: '100kb',
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    }
  })
);

// ============================================================================
// CORS
// ============================================================================

function normalizeOrigin(rawValue: string | undefined): string | null {
  if (!rawValue) {
    return null;
  }

  try {
    return new URL(rawValue.trim()).origin;
  } catch {
    console.warn('FRONTEND_URL no es una URL válida; se ignora para CORS');
    return null;
  }
}

function isLocalOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

const configuredFrontendOrigin = normalizeOrigin(FRONTEND_URL);
const includeConfiguredFrontendOrigin =
  configuredFrontendOrigin !== null && (!IS_PRODUCTION || !isLocalOrigin(configuredFrontendOrigin));

const allowedOrigins = new Set([
  'https://stella-studio-frontend.onrender.com',
  'https://stella-frontend.onrender.com',
  'https://stellaestudio.com',
  'https://www.stellaestudio.com',
  ...(includeConfiguredFrontendOrigin && configuredFrontendOrigin ? [configuredFrontendOrigin] : []),
  ...(IS_PRODUCTION ? [] : ['http://localhost:5173', 'http://localhost:3000'])
]);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Bloqueado por políticas de CORS de Stella Estudio'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
  })
);

// ============================================================================
// Rate limiting
// ============================================================================

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ success: false, error: 'Demasiadas solicitudes' });
  }
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ success: false, error: 'Demasiadas solicitudes' });
  }
});

app.use('/api', apiLimiter);
app.use('/webhook', webhookLimiter);

// ============================================================================
// Helpers
// ============================================================================

function requireKey(envName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = process.env[envName];
    const provided = req.header('x-api-key');

    if (!expected || !provided || !safeEqual(provided, expected)) {
      res.status(401).json({ success: false, error: 'No autorizado' });
      return;
    }

    next();
  };
}

function invalidData(res: Response): void {
  res.status(400).json({ success: false, error: 'Datos inválidos' });
}

function internalError(res: Response, context: string, error: unknown): void {
  console.error(context, error);
  res.status(500).json({ success: false, error: 'Error interno' });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function frontendBackLink(): string {
  if (!FRONTEND_URL) {
    return '';
  }
  return `<p><a href="${escapeHtml(FRONTEND_URL)}">Volver a Stella Estudio</a></p>`;
}

function buildArgentinaDate(date: string, time: string): Date | null {
  const value = new Date(`${date}T${time}:00-03:00`);
  return Number.isNaN(value.getTime()) ? null : value;
}

// ============================================================================
// Validaciones
// ============================================================================

const PHONE_REGEX = /^\+?[0-9]{8,15}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const APPOINTMENT_ID_REGEX = /^[a-zA-Z0-9]{10,40}$/;

const appointmentIdSchema = z.string().regex(APPOINTMENT_ID_REGEX);

const optionalEmailSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().email().max(120).optional()
);

const appointmentBodySchema = z
  .object({
    customerName: z.string().trim().min(2).max(80),
    customerPhone: z.string().regex(PHONE_REGEX),
    customerEmail: optionalEmailSchema,
    serviceId: z.string().min(10).max(40),
    dateTime: z.string().datetime({ offset: true })
  })
  .refine((data) => new Date(data.dateTime).getTime() > Date.now(), {
    message: 'La fecha debe ser futura'
  });

const botpressCreateAppointmentSchema = z.object({
  serviceId: z.string().min(10).max(40),
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().regex(PHONE_REGEX),
  date: z.string().regex(DATE_REGEX),
  time: z.string().regex(TIME_REGEX)
});

const botpressCheckAvailabilitySchema = z.object({
  serviceId: z.string().min(1).max(40),
  date: z.string().regex(DATE_REGEX),
  time: z.string().regex(TIME_REGEX)
});

const botpressServicesSchema = z.object({
  category: z.string().trim().max(40).optional()
});

const botpressAppointmentsQuerySchema = z
  .object({
    phone: z.string().min(1).max(20).optional(),
    name: z.string().min(1).max(80).optional()
  })
  .refine((data) => Boolean(data.phone || data.name), {
    message: 'Se requiere phone o name'
  });

const botpressProfessionalsQuerySchema = z.object({
  category: z.string().trim().min(1).max(40)
});

const botpressCancelAppointmentSchema = z.object({
  appointmentId: z.string().min(10).max(40),
  reason: z.string().max(200).optional()
});

const whatsappSendSchema = z.object({
  to: z.string().regex(PHONE_REGEX),
  message: z.string().min(1).max(1000)
});

const sentimentAnalyzeSchema = z.object({
  text: z.string().min(1).max(2000)
});

// ============================================================================
// Endpoints públicos
// ============================================================================

app.get('/health', (_req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

app.get('/api/services', async (_req, res) => {
  try {
    const services = await prisma.service.findMany();
    res.json({ success: true, data: services });
  } catch (error) {
    internalError(res, 'Error al obtener servicios:', error);
  }
});

app.get('/api/services/:id', async (req, res) => {
  try {
    const service = await prisma.service.findUnique({
      where: { id: req.params.id }
    });
    if (!service) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }
    res.json({ success: true, data: service });
  } catch (error) {
    internalError(res, 'Error al obtener servicio:', error);
  }
});

app.post('/api/appointments', async (req, res) => {
  const parsed = appointmentBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return invalidData(res);
  }

  const { customerName, customerPhone, customerEmail, serviceId, dateTime } = parsed.data;

  try {
    const service = await prisma.service.findUnique({ where: { id: serviceId } });
    if (!service) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    const tenant = await prisma.tenant.findFirst();
    if (!tenant) {
      console.error('No hay tenant configurado');
      return res.status(500).json({ success: false, error: 'Error interno' });
    }

    const appointment = await prisma.appointment.create({
      data: {
        customerName,
        customerPhone,
        customerEmail,
        serviceId,
        dateTime: new Date(dateTime),
        durationMins: service.durationMins,
        depositAmount: service.deposit,
        status: 'PENDING',
        depositStatus: 'NOT_PAID',
        tenantId: tenant.id
      },
      include: { service: true }
    });

    res.json({ success: true, data: appointment });
  } catch (error) {
    internalError(res, 'Error al crear cita:', error);
  }
});

app.get('/api/appointments', requireKey('ADMIN_API_KEY'), async (_req, res) => {
  try {
    const appointments = await prisma.appointment.findMany({
      include: { service: true },
      orderBy: { dateTime: 'asc' }
    });
    res.json({ success: true, data: appointments });
  } catch (error) {
    internalError(res, 'Error al obtener citas:', error);
  }
});

// ============================================================================
// MercadoPago
// ============================================================================

app.post('/api/payments/create/:appointmentId', async (req, res) => {
  const parsedId = appointmentIdSchema.safeParse(req.params.appointmentId);
  if (!parsedId.success) {
    return invalidData(res);
  }

  const appointmentId = parsedId.data;

  try {
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { service: true, tenant: true, payment: true }
    });

    if (!appointment) {
      return res.status(404).json({ success: false, error: 'Cita no encontrada' });
    }

    const holdExpired =
      appointment.status === 'HOLD' &&
      appointment.holdExpiresAt !== null &&
      appointment.holdExpiresAt.getTime() <= Date.now();

    if (appointment.depositStatus === 'PAID' || appointment.payment?.status === 'APPROVED') {
      return res.status(409).json({ success: false, error: 'El turno ya tiene la seña paga' });
    }

    if (appointment.status === 'CANCELLED' || holdExpired) {
      return res.status(409).json({ success: false, error: 'El turno está cancelado o expiró' });
    }

    const amount = appointment.depositAmount ?? appointment.service.deposit;
    const payerEmail = MP_SANDBOX ? TEST_PAYER_EMAIL : appointment.customerEmail;

    const preference = {
      items: [
        {
          title: `Seña - ${appointment.service.name}`,
          quantity: 1,
          currency_id: 'ARS' as any,
          unit_price: amount
        }
      ],
      payer: {
        name: appointment.customerName,
        ...(payerEmail ? { email: payerEmail } : {})
      },
      external_reference: appointmentId,
      back_urls: {
        success: `${BACKEND_URL}/api/payments/success`,
        failure: `${BACKEND_URL}/api/payments/failure`
      },
      auto_return: 'approved'
    };

    const response = await (mercadopago as any).preferences.create(preference);
    const paymentUrl = MP_SANDBOX ? response.body.sandbox_init_point : response.body.init_point;

    await prisma.payment.upsert({
      where: { appointmentId },
      update: {
        amount,
        status: 'PENDING',
        provider: 'MERCADOPAGO',
        providerPaymentId: response.body.id,
        metadata: { preference_id: response.body.id }
      },
      create: {
        tenantId: appointment.tenantId,
        appointmentId,
        amount,
        type: 'DEPOSIT',
        status: 'PENDING',
        provider: 'MERCADOPAGO',
        providerPaymentId: response.body.id,
        metadata: { preference_id: response.body.id }
      }
    });

    res.json({
      success: true,
      paymentUrl,
      preferenceId: response.body.id,
      amount
    });
  } catch (error) {
    internalError(res, 'Error al crear pago:', error);
  }
});

app.get('/api/payments/status/:appointmentId', async (req, res) => {
  const parsedId = appointmentIdSchema.safeParse(req.params.appointmentId);
  if (!parsedId.success) {
    return invalidData(res);
  }

  try {
    const appointment = await prisma.appointment.findUnique({
      where: { id: parsedId.data }
    });

    if (!appointment) {
      return res.status(404).json({ success: false, error: 'Cita no encontrada' });
    }

    res.json({
      success: true,
      status: appointment.depositStatus,
      message: appointment.depositStatus === 'PAID' ? 'Pago confirmado' : 'Pago pendiente'
    });
  } catch (error) {
    internalError(res, 'Error al obtener estado de pago:', error);
  }
});

app.get('/api/payments/success', (_req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html lang="es">
      <head><meta charset="utf-8"><title>Pago exitoso</title></head>
      <body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h2 style="color: #2ecc71;">✅ ¡Pago Aprobado con Éxito!</h2>
        <p>El turno ya quedó confirmado en el sistema.</p>
        ${frontendBackLink()}
      </body>
    </html>
  `);
});

app.get('/api/payments/failure', (_req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html lang="es">
      <head><meta charset="utf-8"><title>Pago no procesado</title></head>
      <body style="font-family: sans-serif; text-align: center; padding: 50px;">
        <h2 style="color: #e74c3c;">❌ Pago No Procesado</h2>
        <p>Mercado Pago rechazó la transacción.</p>
        ${frontendBackLink()}
      </body>
    </html>
  `);
});

let mpSecretWarningShown = false;

function isValidMercadoPagoSignature(req: Request): boolean {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    if (!mpSecretWarningShown) {
      console.warn('MP_WEBHOOK_SECRET no configurado: se omite la validación de firma');
      mpSecretWarningShown = true;
    }
    return true;
  }

  const signature = req.header('x-signature');
  const requestId = req.header('x-request-id');
  const rawDataId = req.query['data.id'];

  if (!signature || !requestId || typeof rawDataId !== 'string') {
    return false;
  }

  const parts = new Map<string, string>();
  for (const part of signature.split(',')) {
    const separator = part.indexOf('=');
    if (separator !== -1) {
      parts.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
    }
  }

  const ts = parts.get('ts');
  const v1 = parts.get('v1');
  if (!ts || !v1) {
    return false;
  }

  const normalizedDataId = /^[a-z0-9]+$/i.test(rawDataId) ? rawDataId.toLowerCase() : rawDataId;
  const manifest = `id:${normalizedDataId};request-id:${requestId};ts:${ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest('hex');

  return safeEqual(v1, expected);
}

app.post('/webhook/mercadopago', async (req, res) => {
  try {
    if (!isValidMercadoPagoSignature(req)) {
      return res.status(401).json({ success: false, error: 'No autorizado' });
    }

    const { type, data } = req.body ?? {};

    if (type !== 'payment') {
      return res.sendStatus(200);
    }

    if (!data || (typeof data.id !== 'string' && typeof data.id !== 'number')) {
      return res.sendStatus(200);
    }

    const paymentResponse = await (mercadopago as any).payment.findById(data.id);
    const payment = paymentResponse.body ?? paymentResponse;

    if (payment.status !== 'approved') {
      return res.sendStatus(200);
    }

    const appointmentId = payment.external_reference;
    if (!appointmentId || typeof appointmentId !== 'string') {
      console.error('Webhook MercadoPago: pago sin external_reference válido');
      return res.sendStatus(200);
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { service: true }
    });

    if (!appointment) {
      console.error(`Webhook MercadoPago: cita no encontrada (${appointmentId})`);
      return res.sendStatus(200);
    }

    if (appointment.depositStatus === 'PAID') {
      return res.sendStatus(200);
    }

    const expectedAmount = Number(appointment.depositAmount ?? appointment.service.deposit);
    const paidAmount = Number(payment.transaction_amount);

    if (
      payment.currency_id !== 'ARS' ||
      !Number.isFinite(paidAmount) ||
      Math.abs(paidAmount - expectedAmount) > 0.01
    ) {
      console.error(`Webhook MercadoPago: monto o moneda no coinciden para cita ${appointmentId}`);
      return res.sendStatus(200);
    }

    const holdExpired =
      appointment.status === 'HOLD' &&
      appointment.holdExpiresAt !== null &&
      appointment.holdExpiresAt.getTime() <= Date.now();

    if (appointment.status === 'CANCELLED' || holdExpired) {
      // El pago se registra para poder auditarlo o reembolsarlo, pero el turno no se revive.
      await prisma.payment.updateMany({
        where: { appointmentId },
        data: {
          status: 'APPROVED',
          providerPaymentId: String(payment.id)
        }
      });

      if (holdExpired) {
        await prisma.appointment.update({
          where: { id: appointmentId },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date()
          }
        });
      }

      console.warn(
        `Webhook MercadoPago: pago aprobado para cita ${appointmentId} cancelada o con HOLD expirado; no se confirma`
      );
      return res.sendStatus(200);
    }

    await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        depositStatus: 'PAID',
        status: 'CONFIRMED',
        paymentId: String(payment.id)
      }
    });

    await prisma.payment.updateMany({
      where: { appointmentId },
      data: {
        status: 'APPROVED',
        providerPaymentId: String(payment.id)
      }
    });

    console.log(`Pago aprobado para cita ${appointmentId}`);
    return res.sendStatus(200);
  } catch (error) {
    console.error('Error en webhook de MercadoPago:', error);
    res.status(500).json({ success: false, error: 'Error interno' });
  }
});

// ============================================================================
// WhatsApp
// ============================================================================

app.get('/webhook/whatsapp', WhatsAppWebhookController.verifyWebhook);
app.post('/webhook/whatsapp', WhatsAppWebhookController.handleWebhook);

app.post('/api/whatsapp/send', requireKey('ADMIN_API_KEY'), async (req, res) => {
  const parsed = whatsappSendSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return invalidData(res);
  }

  try {
    const whatsappService = new WhatsAppService();
    const result = await whatsappService.sendTextMessage(parsed.data.to, parsed.data.message);
    res.json({ success: true, data: result });
  } catch (error) {
    internalError(res, 'Error al enviar mensaje de WhatsApp:', error);
  }
});

// ============================================================================
// Botpress (protegido con x-api-key)
// ============================================================================

app.use('/api/botpress', requireKey('BOTPRESS_API_KEY'));

app.post('/api/botpress/services', async (req, res) => {
  const parsed = botpressServicesSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return invalidData(res);
  }

  const { category } = parsed.data;

  try {
    const services = await prisma.service.findMany({
      where: {
        isActive: true,
        ...(category && category !== 'todos' ? { category } : {})
      }
    });

    res.json({
      success: true,
      services: services.map((service) => ({
        id: service.id,
        name: service.name,
        price: service.price,
        duration: service.durationMins,
        deposit: service.deposit
      }))
    });
  } catch (error) {
    internalError(res, 'Error al listar servicios para Botpress:', error);
  }
});

app.post('/api/botpress/check-availability', async (req, res) => {
  const parsed = botpressCheckAvailabilitySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return invalidData(res);
  }

  const { serviceId, date, time } = parsed.data;
  const dateTime = buildArgentinaDate(date, time);

  if (!dateTime) {
    return invalidData(res);
  }

  try {
    const existingAppointment = await prisma.appointment.findFirst({
      where: {
        serviceId,
        dateTime,
        status: { not: 'CANCELLED' }
      }
    });

    res.json({ success: true, available: !existingAppointment });
  } catch (error) {
    internalError(res, 'Error al verificar disponibilidad:', error);
  }
});

app.post('/api/botpress/create-appointment', async (req, res) => {
  const parsed = botpressCreateAppointmentSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return invalidData(res);
  }

  const { serviceId, customerName, customerPhone, date, time } = parsed.data;
  const dateTime = buildArgentinaDate(date, time);

  if (!dateTime || dateTime.getTime() <= Date.now()) {
    return invalidData(res);
  }

  try {
    const service = await prisma.service.findUnique({ where: { id: serviceId } });
    if (!service) {
      return res.status(404).json({ success: false, error: 'Servicio no encontrado' });
    }

    const tenant = await prisma.tenant.findFirst();
    if (!tenant) {
      console.error('No hay tenant configurado');
      return res.status(500).json({ success: false, error: 'Error interno' });
    }

    const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const appointment = await prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        serviceId: service.id,
        customerName,
        customerPhone,
        customerEmail: null,
        dateTime,
        durationMins: service.durationMins,
        depositAmount: service.deposit,
        status: 'HOLD',
        depositStatus: 'NOT_PAID',
        holdExpiresAt
      }
    });

    let paymentUrl = '';

    try {
      const amount = appointment.depositAmount ?? 0;
      const payerEmail = MP_SANDBOX ? TEST_PAYER_EMAIL : undefined;

      const preference = {
        items: [
          {
            title: `Seña Secreta - ${service.name}`,
            quantity: 1,
            currency_id: 'ARS' as any,
            unit_price: Number(amount) || 0
          }
        ],
        payer: {
          name: customerName.trim(),
          ...(payerEmail ? { email: payerEmail } : {}),
          phone: {
            area_code: '54',
            number: Number(String(customerPhone).replace(/\D/g, '')) || 1111111111
          }
        },
        external_reference: appointment.id,
        back_urls: {
          success: `${BACKEND_URL}/api/payments/success`,
          failure: `${BACKEND_URL}/api/payments/failure`
        },
        auto_return: 'all'
      };

      const mpResponse = await (mercadopago as any).preferences.create(preference);
      paymentUrl = MP_SANDBOX ? mpResponse.body.sandbox_init_point : mpResponse.body.init_point;

      await prisma.payment.upsert({
        where: { appointmentId: appointment.id },
        update: {
          amount,
          status: 'PENDING',
          provider: 'MERCADOPAGO',
          providerPaymentId: mpResponse.body.id,
          metadata: { preference_id: mpResponse.body.id }
        },
        create: {
          tenantId: tenant.id,
          appointmentId: appointment.id,
          amount,
          type: 'DEPOSIT',
          status: 'PENDING',
          provider: 'MERCADOPAGO',
          providerPaymentId: mpResponse.body.id,
          metadata: { preference_id: mpResponse.body.id }
        }
      });
    } catch (mpError) {
      const message = mpError instanceof Error ? mpError.message : 'error desconocido';
      console.error(`Error al generar el pago de MercadoPago para la cita ${appointment.id}:`, message);
    }

    console.log(`Turno creado en estado HOLD: ${appointment.id}`);

    return res.json({
      success: true,
      appointment: {
        id: appointment.id,
        paymentUrl
      }
    });
  } catch (error) {
    internalError(res, 'Error al crear turno desde Botpress:', error);
  }
});

app.post('/api/sentiment/analyze', (req, res) => {
  const parsed = sentimentAnalyzeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return invalidData(res);
  }

  try {
    const { sentimentAnalyzer } = require('./modules/messaging/processors/sentiment.analyzer');
    const result = sentimentAnalyzer.analyze(parsed.data.text);
    res.json({ success: true, data: result });
  } catch (error) {
    internalError(res, 'Error al analizar sentimiento:', error);
  }
});

app.get('/api/botpress/appointments', async (req, res) => {
  const parsed = botpressAppointmentsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return invalidData(res);
  }

  const { phone, name } = parsed.data;
  const whereClause: any = {};

  if (phone) {
    whereClause.customerPhone = phone;
  }
  if (name) {
    whereClause.customerName = { contains: name, mode: 'insensitive' };
  }

  try {
    const appointments = await prisma.appointment.findMany({
      where: whereClause,
      include: { service: true },
      orderBy: { dateTime: 'desc' },
      take: 10
    });
    res.json({ success: true, appointments });
  } catch (error) {
    internalError(res, 'Error al buscar turnos para Botpress:', error);
  }
});

app.post('/api/botpress/cancel-appointment', async (req, res) => {
  const parsed = botpressCancelAppointmentSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return invalidData(res);
  }

  const { appointmentId, reason } = parsed.data;

  try {
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { payment: true }
    });

    if (!appointment) {
      return res.status(404).json({ success: false, error: 'Turno no encontrado' });
    }

    const hoursBefore = (new Date(appointment.dateTime).getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursBefore < 2) {
      return res.json({
        success: false,
        error: 'No se puede cancelar con menos de 2 horas de anticipación',
        cancellationAllowed: false
      });
    }

    const updated = await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        notes: reason || 'Cancelado por cliente'
      }
    });

    res.json({ success: true, message: 'Turno cancelado exitosamente', appointment: updated });
  } catch (error) {
    internalError(res, 'Error al cancelar turno:', error);
  }
});

app.get('/api/botpress/professionals', async (req, res) => {
  const parsed = botpressProfessionalsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return invalidData(res);
  }

  try {
    const professionals = await prisma.professional.findMany({
      where: { category: parsed.data.category, isActive: true },
      include: { professionalServices: { include: { service: true } } }
    });
    res.json({ success: true, professionals });
  } catch (error) {
    internalError(res, 'Error al listar profesionales:', error);
  }
});

// ============================================================================
// Manejo de errores
// ============================================================================

app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err?.message === 'Bloqueado por políticas de CORS de Stella Estudio') {
    res.status(403).json({ success: false, error: 'Origen no permitido' });
    return;
  }

  next(err);
});

// ============================================================================
// Limpieza de reservas HOLD expiradas
// ============================================================================

const holdCleanupInterval = setInterval(async () => {
  try {
    const result = await prisma.appointment.updateMany({
      where: {
        status: 'HOLD',
        holdExpiresAt: { lt: new Date() }
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date()
      }
    });

    if (result.count > 0) {
      console.log(`Turnos HOLD expirados cancelados: ${result.count}`);
    }
  } catch (error) {
    console.error('Error al expirar turnos HOLD:', error);
  }
}, 60 * 1000);

holdCleanupInterval.unref();

// ============================================================================
// Iniciar servidor
// ============================================================================

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log('Endpoints disponibles: GET /health, GET /api/services, POST /api/appointments');
});
