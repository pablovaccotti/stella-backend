// src/modules/whatsapp/services/whatsapp.service.ts
import axios from 'axios';

export class WhatsAppService {
  private accessToken: string;
  private phoneNumberId: string;
  private apiUrl: string;

  constructor() {
    this.accessToken = process.env.WHATSAPP_ACCESS_TOKEN || '';
    this.phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
    this.apiUrl = `https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`;
  }

  // Enviar mensaje de texto
  async sendTextMessage(to: string, text: string): Promise<any> {
    try {
      const response = await axios.post(
        this.apiUrl,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'text',
          text: { body: text }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar mensaje de WhatsApp:', error?.message);
      throw error;
    }
  }

  // Enviar mensaje interactivo con botones (para selección de servicios)
  async sendInteractiveButtons(to: string, bodyText: string, buttons: { id: string; title: string }[]): Promise<any> {
    try {
      const response = await axios.post(
        this.apiUrl,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text: bodyText },
            action: {
              buttons: buttons.map(btn => ({
                type: 'reply',
                reply: { id: btn.id, title: btn.title }
              }))
            }
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar botones de WhatsApp:', error?.message);
      throw error;
    }
  }

  // Enviar lista de servicios (para seleccionar)
  async sendServiceList(to: string, services: any[]): Promise<any> {
    try {
      const rows = services.map(service => ({
        id: service.id,
        title: service.name,
        description: `$${service.price} - Seña: $${service.deposit}`
      }));

      const response = await axios.post(
        this.apiUrl,
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: to,
          type: 'interactive',
          interactive: {
            type: 'list',
            body: { text: '📋 Estos son nuestros servicios disponibles:' },
            footer: { text: 'Selecciona uno para continuar' },
            action: {
              button: 'Ver servicios',
              sections: [
                {
                  title: 'Servicios',
                  rows: rows
                }
              ]
            }
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar lista de WhatsApp:', error?.message);
      throw error;
    }
  }

  // Enviar confirmación de turno
  async sendAppointmentConfirmation(to: string, appointment: any): Promise<any> {
    const message = `✂️ *¡Turno Confirmado!*\n\n` +
      `📅 *Fecha:* ${new Date(appointment.dateTime).toLocaleString()}\n` +
      `💇 *Servicio:* ${appointment.service.name}\n` +
      `💰 *Seña abonada:* $${appointment.depositAmount}\n\n` +
      `📍 Te esperamos en nuestra peluquería.\n` +
      `📞 ¿Necesitas modificar? Responde a este mensaje.`;
    
    return this.sendTextMessage(to, message);
  }
}