# Seeded because the project's technical plan describes a Go service.
#
# This file belongs to you. PromptZone wrote it once at repository creation and
# never overwrites it — grow it into whatever this application actually needs.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
# No `go mod download` step: the seeded scaffold has no dependencies yet, and a
# download of nothing would only fail once this project adds a go.sum.
COPY . .
RUN CGO_ENABLED=0 go build -o /out/app .

FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/app /app/app
COPY public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["/app/app"]
