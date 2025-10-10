FROM nginx:alpine

# Copy the updated HTML file with authentication to nginx
COPY index.html /usr/share/nginx/html/

# Copy nginx configuration with CORS support
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]