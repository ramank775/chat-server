{{/*
Expand the name of the chart.
*/}}
{{- define "chatserver.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "chatserver.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "chatserver.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "chatserver.labels" -}}
chatserver.sh/chart: {{ include "chatserver.chart" . }}
{{ include "chatserver.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "chatserver.selectorLabels" -}}
app.kubernetes.io/name: {{ include "chatserver.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "chatserver.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "chatserver.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}


{{/*
Event Store common option
*/}}
{{- define "eventBroker.options" -}}
--event-store={{ .values.eventStore }}
{{- if eq $.Values.eventStore "kafka" -}}
--kafka-broker-list={{ .Values.kafka.brokers }}
--kafka-security-protocol={{ .Values.kafka.security.protocol }}
--kafka-sasl-username={{ .Values.kafka.sasl.username }}
--kafka-sasl-password={{ .Values.kafka.sasl.password }}
--kafka-client-id="${hostname}"
--kafka-consumer-group={{ .Args.consumerGroup }}
{{- end -}}
{{- if eq $.Values.eventStore "nats" -}}
--nats-server-list={{ .Values.nats.servers }}
--nats-auth-type={{ .Values.nats.auth.type }}
--nats-auth-user={{ .Values.nats.auth.user }}
--nats-auth-pass={{ .Values.nats.auth.pass }}
--nats-auth-token={{ .Values.nats.auth.token }}
--nats-auth-nkey={{ .Values.nats.auth.nkey }}
--nats-auth-jwt={{ .Values.nats.auth.jwt }}
--nats-consumer-group={{ .Args.consumerGroup }}
{{- end -}}
{{ -end- }}

{{/*
Mongo Auth options
*/}}
{{- define "mongo.options" -}}
{{- if .Values.mongo.srv -}}
--mongo-url=mongodb+srv://{{ .Values.mongo.host }}:{{ .Values.mongo.port }}/{{ .Values.mongo.db }}?authSource=admin
{{- else -}}
--mongo-url=mongodb://{{ .Values.mongo.host }}:{{ .Values.mongo.port }}/{{ .Values.mongo.db }}
{{- end -}}
{{- if .Values.mongo.auth -}}
--mongo-user={{ .Values.mongo.user }}
--mongo-password={{ .Values.mongo.pass }}
--mongo-auth
{{- end -}}

