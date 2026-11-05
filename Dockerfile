# Etapa de compilación
FROM node:20-slim AS builder

WORKDIR /app

# Instalar dependencias del sistema
RUN apt-get update && apt-get install -y openssl

# Copiar archivos de configuración
COPY backend/package*.json ./
COPY backend/prisma ./prisma/

# Instalar dependencias
RUN npm ci

# Generar Prisma Client
RUN npx prisma generate

# Copiar el resto del código
COPY backend/ .

# Compilar TypeScript a JavaScript
RUN npm run build

# ------------------------------
# Etapa de producción
FROM node:20-slim

# Instalar dependencias del sistema
RUN apt-get update && apt-get install -y openssl

WORKDIR /app

# Copiar dependencias y código compilado
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/dist ./dist

USER node

EXPOSE 3000

CMD ["node", "dist/server.js"]