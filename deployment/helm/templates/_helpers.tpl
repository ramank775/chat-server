{{- define "chatserver.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "chatserver.selectorLabels" -}}
app.kubernetes.io/name: {{ include "chatserver.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "chatserver.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "chatserver.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Flags every http service takes. Takes (dict "root" $ "port" n). */}}
{{- define "chatserver.httpArgs" -}}
- --host=0.0.0.0
- --port={{ .port }}
- --min-app-build={{ .root.Values.minAppBuild }}
- --latest-app-build={{ .root.Values.latestAppBuild }}
{{- end }}

{{/* The event bus. Takes (dict "root" $ "group" consumer-group-or-empty). */}}
{{- define "chatserver.busArgs" -}}
{{- $v := .root.Values }}
- --event-store={{ $v.eventStore }}
- --new-message-topic=new-message
- --offline-message-topic=offline-message
{{- if eq $v.eventStore "kafka" }}
- --kafka-broker-list={{ $v.kafka.brokers }}
- --kafka-client-id=$(POD_NAME)
{{- with .group }}
- --kafka-consumer-group={{ . }}
{{- end }}
{{- else }}
- --nats-server-list={{ $v.nats.servers }}
{{- with .group }}
- --nats-consumer-group={{ . }}
{{- end }}
{{- end }}
{{- end }}

{{/* The database. Takes (dict "root" $ "stores" (list "profile-db" ...)). */}}
{{- define "chatserver.dbArgs" -}}
{{- $v := .root.Values }}
{{- range .stores }}
- --{{ . }}={{ $v.dbBackend }}
{{- end }}
{{- if eq $v.dbBackend "pg" }}
- --pg-url=postgres://{{ $v.pg.user }}:$(DB_PASSWORD)@{{ $v.pg.host }}/{{ $v.pg.database }}
{{- else }}
- --mongo-url={{ $v.mongo.url }}
{{- with $v.mongo.user }}
- --mongo-user={{ . }}
- --mongo-password=$(DB_PASSWORD)
- --mongo-auth
{{- end }}
{{- end }}
{{- end }}

{{/*
One service: a Deployment, and a Service named as docker-compose.yml names
it when it listens. Takes (dict "root" $ "name" n "script" path "port" n
"replicas" n "args" rendered-arg-lines).
*/}}
{{- define "chatserver.service" -}}
{{- $root := .root }}
{{- $v := $root.Values }}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .name }}
  labels:
    {{- include "chatserver.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .name }}
spec:
  replicas: {{ .replicas }}
  selector:
    matchLabels:
      {{- include "chatserver.selectorLabels" $root | nindent 6 }}
      app.kubernetes.io/component: {{ .name }}
  template:
    metadata:
      labels:
        {{- include "chatserver.selectorLabels" $root | nindent 8 }}
        app.kubernetes.io/component: {{ .name }}
      {{- with $v.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
    spec:
      {{- with $v.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      containers:
        - name: {{ .name }}
          image: "{{ $v.image.repository }}:{{ $v.image.tag | default $root.Chart.AppVersion }}"
          imagePullPolicy: {{ $v.image.pullPolicy }}
          command: [node]
          args:
            - {{ .script }}
            - --app-name={{ .name }}
            {{- .args | nindent 12 }}
            {{- range $v.extraArgs }}
            - {{ . | quote }}
            {{- end }}
          env:
            - name: POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
          envFrom:
            - secretRef:
                name: {{ $v.secretName }}
          {{- if .port }}
          ports:
            - name: http
              containerPort: {{ .port }}
          readinessProbe:
            httpGet:
              path: /alive
              port: http
          {{- end }}
          {{- with $v.resources }}
          resources:
            {{- toYaml . | nindent 12 }}
          {{- end }}
{{- if .port }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .name }}
  labels:
    {{- include "chatserver.labels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .name }}
spec:
  selector:
    {{- include "chatserver.selectorLabels" $root | nindent 4 }}
    app.kubernetes.io/component: {{ .name }}
  ports:
    - name: http
      port: {{ .port }}
      targetPort: http
{{- end }}
{{- end }}
