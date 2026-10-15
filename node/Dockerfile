FROM node:20-bullseye

WORKDIR /app

# Install system dependencies for PDF processing and OCR
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-eng \
    libtesseract-dev \
    poppler-utils \
    graphicsmagick \
    ghostscript \
    imagemagick \
    python3 \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Fix ImageMagick policy for PDF
RUN sed -i 's/rights="none" pattern="PDF"/rights="read|write" pattern="PDF"/' /etc/ImageMagick-6/policy.xml || true

COPY package*.json ./

# Install Node dependencies
RUN npm ci --omit=dev --legacy-peer-deps

COPY . .

RUN mkdir -p uploads && chmod 700 uploads

EXPOSE 5001 5002 5003 5004 6001 6002 6003 6004

CMD ["node", "server.js"]