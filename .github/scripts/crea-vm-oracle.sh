#!/usr/bin/env bash
# Prova a creare la VM Oracle Cloud Always Free (Ampere A1) finché Oracle non ha posto libero.
# Lanciato dal workflow "Crea VM Oracle". Non crea mai una seconda VM: se ne esiste già una A1
# la segnala e si ferma. Prepara anche la rete (porte 22, 80, 443) se non c'è.
#
# Variabili d'ambiente: OCI_CLI_CONFIG_FILE (config dell'API key), SSH_PUBLIC_KEY_FILE.
# Uscita: 0 = VM pronta (scrive vm_ip in $GITHUB_OUTPUT) oppure ancora niente posto;
#         1 = errore vero, da guardare.
set -euo pipefail

SHAPE="VM.Standard.A1.Flex"
NAME="vm-progetti"
ATTEMPTS="${ATTEMPTS:-5}"
PAUSE="${PAUSE:-60}"
# Prima la VM grande (tutti i progetti), poi la piccola, che trova posto più facilmente.
SIZES=("2 12" "1 6")

out() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1" >> "$GITHUB_OUTPUT" || true; }
oci_json() { local r; r="$(oci "$@" --output json)"; echo "${r:-"{\"data\":[]}"}"; }

TENANCY="$(sed -n 's/^tenancy[[:space:]]*=[[:space:]]*//p' "$OCI_CLI_CONFIG_FILE" | head -1)"
[ -n "$TENANCY" ] || { echo "OCI_CONFIG non contiene la riga tenancy=…"; exit 1; }

public_ip() {
  oci_json compute instance list-vnics --instance-id "$1" | jq -r '.data[0]["public-ip"] // empty'
}

# 1. Esiste già una VM A1? Allora abbiamo finito.
existing="$(oci_json compute instance list -c "$TENANCY" --all \
  | jq -r --arg s "$SHAPE" '[.data[] | select(.shape == $s and .["lifecycle-state"] != "TERMINATED" and .["lifecycle-state"] != "TERMINATING")][0].id // empty')"
if [ -n "$existing" ]; then
  ip="$(public_ip "$existing")"
  echo "La VM esiste già. IP pubblico: ${ip:-non ancora assegnato}"
  out "vm_ip=$ip"
  exit 0
fi

# 2. Availability domain e immagine Ubuntu 24.04 per ARM.
AD="$(oci_json iam availability-domain list -c "$TENANCY" | jq -r '.data[0].name')"
IMAGE="$(oci_json compute image list -c "$TENANCY" --all --operating-system "Canonical Ubuntu" \
  --operating-system-version "24.04" --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC \
  | jq -r '[.data[] | select(.["display-name"] | test("Minimal") | not)][0].id // empty')"
[ -n "$IMAGE" ] || { echo "Immagine Ubuntu 24.04 per $SHAPE non trovata"; exit 1; }

# 3. Rete: usa una subnet pubblica esistente, altrimenti la crea.
SUBNET="$(oci_json network subnet list -c "$TENANCY" --all \
  | jq -r '[.data[] | select(.["prohibit-public-ip-on-vnic"] == false and .["lifecycle-state"] == "AVAILABLE")][0].id // empty')"
if [ -z "$SUBNET" ]; then
  echo "Nessuna subnet pubblica: creo la rete."
  VCN="$(oci network vcn create -c "$TENANCY" --cidr-blocks '["10.0.0.0/16"]' --display-name vcn-progetti \
    --dns-label progetti --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
  IGW="$(oci network internet-gateway create -c "$TENANCY" --vcn-id "$VCN" --is-enabled true \
    --display-name internet --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
  RT="$(oci network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)"
  oci network route-table update --rt-id "$RT" --force --route-rules \
    "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null
  SL="$(oci network vcn get --vcn-id "$VCN" --query 'data."default-security-list-id"' --raw-output)"
  SUBNET="$(oci network subnet create -c "$TENANCY" --vcn-id "$VCN" --cidr-block 10.0.0.0/24 \
    --display-name subnet-pubblica --dns-label pubblica --route-table-id "$RT" --security-list-ids "[\"$SL\"]" \
    --prohibit-public-ip-on-vnic false --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
fi

# 4. Porte 80 e 443 aperte nella security list della subnet (SSH 22 c'è già di base).
SL="$(oci network subnet get --subnet-id "$SUBNET" --query 'data."security-list-ids"[0]' --raw-output)"
has80="$(oci_json network security-list get --security-list-id "$SL" \
  | jq '[.data["ingress-security-rules"][] | select(.["tcp-options"]["destination-port-range"].min? == 80)] | length')"
if [ "$has80" = "0" ]; then
  echo "Apro le porte 22, 80 e 443."
  tcp() { printf '{"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":%s,"max":%s}}}' "$1" "$1"; }
  rules="[$(tcp 22),$(tcp 80),$(tcp 443),"
  rules+='{"source":"0.0.0.0/0","protocol":"1","isStateless":false,"icmpOptions":{"type":3,"code":4}},'
  rules+='{"source":"10.0.0.0/16","protocol":"1","isStateless":false,"icmpOptions":{"type":3}}]'
  oci network security-list update --security-list-id "$SL" --force --ingress-security-rules "$rules" >/dev/null
fi

# 5. Tentativi di creazione.
for attempt in $(seq 1 "$ATTEMPTS"); do
  for size in "${SIZES[@]}"; do
    read -r ocpus mem <<< "$size"
    echo "Tentativo $attempt/$ATTEMPTS: $ocpus OCPU, $mem GB…"
    if result="$(oci compute instance launch -c "$TENANCY" --availability-domain "$AD" --shape "$SHAPE" \
        --shape-config "{\"ocpus\":$ocpus,\"memoryInGBs\":$mem}" --image-id "$IMAGE" --subnet-id "$SUBNET" \
        --assign-public-ip true --display-name "$NAME" --ssh-authorized-keys-file "$SSH_PUBLIC_KEY_FILE" \
        --wait-for-state RUNNING --max-wait-seconds 900 --query 'data.id' --raw-output 2>/tmp/oci-err)"; then
      id="$(echo "$result" | grep -o 'ocid1\.instance[^"[:space:]]*' | head -1)"
      ip="$(public_ip "$id")"
      echo "VM creata ($ocpus OCPU, $mem GB). IP pubblico: $ip"
      out "vm_ip=$ip"
      out "vm_size=$ocpus OCPU, $mem GB"
      exit 0
    fi
    if grep -qi "capacity" /tmp/oci-err; then
      echo "  Oracle non ha posto."
    elif grep -qi "TooManyRequests" /tmp/oci-err; then
      echo "  Troppe richieste, aspetto."
      sleep "$PAUSE"
    else
      echo "Errore inatteso da Oracle:"; sed 's/ocid1\.[a-z0-9._-]*/ocid1…/g' /tmp/oci-err | head -20
      exit 1
    fi
  done
  [ "$attempt" -lt "$ATTEMPTS" ] && sleep "$PAUSE"
done
echo "Ancora niente posto: riprovo al prossimo giro."
