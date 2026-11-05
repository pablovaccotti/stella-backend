// create-appointment.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    // Obtener tenant y servicio
    const tenant = await prisma.tenant.findFirst();
    const service = await prisma.service.findFirst();
    
    if (!tenant) console.log('❌ Tenant no encontrado');
    if (!service) console.log('❌ Servicio no encontrado');
    if (!tenant || !service) return;
    
    console.log('📋 Tenant:', tenant.name);
    console.log('📋 Servicio:', service.name);
    console.log('📋 Duración:', service.durationMins, 'minutos');
    
    // Crear la cita
    const appointment = await prisma.appointment.create({
      data: {
        customerName: 'Cliente de Prueba',
        customerPhone: '+5400000000',
        customerEmail: 'test@example.com',
        serviceId: service.id,
        dateTime: new Date('2026-05-20T10:00:00'),
        durationMins: service.durationMins,
        depositAmount: service.deposit,
        status: 'PENDING',
        depositStatus: 'NOT_PAID',
        tenantId: tenant.id
      },
      include: { service: true }
    });
    
    console.log('\n✅ Cita creada exitosamente!');
    console.log('📅 Fecha:', appointment.dateTime);
    console.log('💇 Servicio:', appointment.service.name);
    console.log('💰 Seña:', appointment.depositAmount);
    console.log('🆔 ID:', appointment.id);
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();