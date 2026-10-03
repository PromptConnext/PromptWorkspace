# Seeded because the project's technical plan describes a Python service.
#
# This file belongs to you. PromptWorkspace wrote it once at repository creation and
# never overwrites it — grow it into whatever this application actually needs.
FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["python", "main.py"]
