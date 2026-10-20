// Actual browser policy module; no shell, remote machine, model or network runs.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';

const context = { window: {} };
runInNewContext(readFileSync(new URL('../src/ai-command-policy.js', import.meta.url), 'utf8'), context);
const policy = context.window.AiCommandPolicy;
let checks = 0;
function check(name, value) { assert.ok(value, name); checks++; console.log('PASS ' + name); }
function assess(command, effect = 'read_only', reason) {
  const result = policy.assess(command, effect, reason);
  assert.equal(typeof result.readOnly, 'boolean');
  assert.ok(Array.isArray(result.reasons) && result.reasons.length && result.reasons.every(value => typeof value === 'string' && value.length));
  assert.deepEqual(Object.keys(result).sort(), ['readOnly', 'reasons']);
  return result;
}
try {
  check('P01 policy exposes its exact assessment interface', typeof policy.assess === 'function');
  for (const effect of [undefined, null, '', 'readonly', 'READ_ONLY', ' read_only', 'read_only ', true, 1, {}, ['read_only'], '{"effect":"read_only"}']) {
    check('P02 missing/noncanonical model classification never becomes automatic: ' + String(effect), policy.assess('pwd', effect).readOnly === false);
  }
  for (const effect of ['modify', 'unknown']) {
    check('P03 local query knowledge never upgrades model ' + effect, !assess('pwd', effect, '模型没有授权自动执行').readOnly);
  }
  for (const reason of [undefined, null, '', '只读取当前系统信息', 'a'.repeat(1024), '中'.repeat(341), '😀'.repeat(256)]) {
    check('P04 optional and valid UTF8-bounded reasons are accepted', assess('pwd', 'read_only', reason).readOnly);
  }
  for (const reason of [1, false, {}, [], 'a'.repeat(1025), '中'.repeat(342), '😀'.repeat(257)]) {
    check('P05 invalid reason type or UTF8 byte overflow cannot be automatic', !assess('pwd', 'read_only', reason).readOnly);
  }
  for (const code of [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => i + 127)]) {
    check('P06 model reasons reject control U+' + code.toString(16), !assess('pwd', 'read_only', 'a' + String.fromCharCode(code) + 'b').readOnly);
  }
  const queries = [
    'pwd', 'whoami', 'id', 'uname -a', 'hostname -f', 'uptime', 'ls -lah /tmp',
    'cat /etc/os-release', 'head -n 20 /var/log/app.log', 'tail -n 30 /var/log/app.log',
    'df -h', 'du -sh /var/log', 'free -m', 'ps aux', 'ss -lntup',
    'ip -br addr show', 'ip route show table main', 'ip link show dev eth0',
    'systemctl --no-pager status ssh.service', 'systemctl --no-pager show --property=ActiveState ssh.service',
    'systemctl --no-pager is-active ssh.service', 'systemctl --no-pager list-units',
    'journalctl --no-pager -u ssh.service -n 20', 'journalctl --no-pager --disk-usage',
    'git status --short', 'git --no-pager diff --no-ext-diff --no-textconv', 'git log -n 5', 'git show HEAD', 'git rev-parse --show-toplevel',
    'docker ps', 'docker container ls', 'docker image inspect app', 'kubectl get pods -n default',
    'kubectl --context staging --namespace default get services', 'kubectl describe pod app',
    'custom-healthcheck --report', 'lsof -nP', 'getent passwd fixture',
    "cat 'a file; with $(literal) and `text`'", 'cat "a file with spaces"', 'cat a\\ file',
    "grep 'rm -rf /; touch /tmp/x' /tmp/log", "find /tmp -name '*.log'", "find /tmp -name '-delete'",
    "docker inspect --format '{{.State.Status}}' app", 'sort -- --output=literal-filename',
    'git diff -- --output=literal-path', 'curl --head https://example.invalid/',
  ];
  for (const command of queries) check('P07 model-read-only query passes basic veto: ' + command, assess(command).readOnly);
  const syntax = [
    'pwd; touch /tmp/x', 'pwd && touch /tmp/x', 'pwd || touch /tmp/x', 'pwd | cat', 'pwd &',
    'printf x > /tmp/x', 'cat < /tmp/x', 'cat <<< x', 'cat << EOF', 'ls 2>/tmp/x',
    'pwd\ntouch /tmp/x', 'pwd\rwhoami', 'cat "$(touch /tmp/x)"', 'cat `touch /tmp/x`',
    'cat ${FILE}', 'cat "$FILE"', 'cat <(touch /tmp/x)', '(pwd)', '{ pwd; }',
    'ls *', 'ls /tmp/[ab]', 'ls ~', 'pwd # ignored', 'cat "unterminated', "cat 'unterminated", 'cat trailing\\',
    'PATH=/tmp ls', 'X=1 docker ps', 'pwd\u0000', 'pwd\u001b',
  ];
  for (const command of syntax) check('P08 shell syntax cannot hide uncertain side effects: ' + JSON.stringify(command), !assess(command).readOnly);
  const writes = [
    'touch /tmp/x', 'rm -rf /tmp/x', '/bin/rm -f /tmp/x', "r''m /tmp/x", 'r\\m /tmp/x', 'cp source target', 'mv source target',
    'mkdir /tmp/x', 'tee /tmp/x', 'chmod 777 /tmp/x', 'chown root /tmp/x', 'dd if=/dev/zero of=/tmp/x',
    'reboot', 'shutdown now', 'kill -9 123', 'mount /dev/sda /mnt', 'mkfs.ext4 /dev/fixture',
    'sudo -n ls', 'env X=1 rm /tmp/x', 'command rm /tmp/x', 'busybox rm /tmp/x', 'timeout 10 rm /tmp/x',
    "sh -c 'touch /tmp/x'", "python3 -c 'open(\"/tmp/x\",\"w\").write(\"x\")'", "awk 'BEGIN {system(\"touch /tmp/x\")}'", "sed -i 's/a/b/' /tmp/x",
    "find /tmp -exec touch /tmp/x \\;", 'find /tmp -delete', 'find /tmp -fprint /tmp/x',
    'sort -o/tmp/x /tmp/y', 'sort --out=/tmp/x /tmp/y', 'hostname new-name', 'hostname -F/etc/hostname', 'hostname --fi=/tmp/x',
    'ss -tnK', 'ss --kil', 'ss -D/tmp/x', 'df --sync',
    'systemctl --no-pager restart ssh', 'systemctl --no-pager enable ssh', 'systemctl status ssh',
    'journalctl --no-pager --rot', 'journalctl --no-pager --vacuum-s=1M', 'journalctl --flush',
    'ip addr add 127.0.0.2 dev lo', 'ip link set eth0 down', 'ip link s eth0 down', 'ip -batch /tmp/script', 'ip netns exec ns rm /tmp/x',
    'git -c alias.status=whatever status', 'git --config-env=alias.foo=EVIL foo', 'git config core.pager whatever',
    'git diff --out=/tmp/x', 'git diff --ext-diff', 'git show --textconv HEAD', 'git log --show-signature',
    'git checkout branch', 'git reset --hard', 'git push origin main', 'git branch new-branch', 'git branch -D old', 'git tag new-tag',
    'curl -o/tmp/x https://example.invalid/', 'curl -XPOST https://example.invalid/', 'curl --data=x https://example.invalid/',
    'curl --config /tmp/requests', 'wget https://example.invalid/',
    'docker exec app sh', 'docker container rm app', 'docker compose up -d', 'docker context use production',
    'kubectl delete pod app', 'kubectl -n default apply -f manifest.yaml', 'kubectl rollout restart deploy/app', 'kubectl config use-context production',
    'npm install package', 'npm run build', 'pip install package', 'terraform apply', 'helm install app chart',
    'iptables -A INPUT -j DROP', 'nft flush ruleset', 'sysctl -w net.ipv4.ip_forward=1',
    'ip --batch /tmp/routes', 'ip --force --batch /tmp/routes',
    'docker container --context prod exec app sh', 'docker --tlscacert ps run alpine true',
    'kubectl --cache-dir get delete pod fixture', 'helm --namespace list uninstall fixture', 'npm --prefix list install fixture', 'pip --log logfile list',
    'git archive -o /tmp/out.tar HEAD', 'git format-patch -1', 'git hash-object -w file',
    'uniq input output', 'uniq --skip-chars 2 input output', 'split input prefix', 'csplit input 2',
    'systemctl --message status reboot --no-pager', 'systemctl --mess status reboot --no-pager',
    'del fixture.txt', 'erase fixture.txt', 'rd fixture', 'copy source target', 'move source target', 'ren source target', 'rename source target',
    'Remove-Item fixture.txt', 'Set-Content fixture.txt value', 'Add-Content fixture.txt value', 'New-Item fixture.txt', 'Out-File fixture.txt',
    'Stop-Process -Id 123', 'Stop-Service fixture', 'Restart-Service fixture',
    'whoami \\; Remove-Item fixture.txt', 'Write-Output "x\\"; Remove-Item fixture.txt; \\"z"',
    "Write-Output 'x’; Remove-Item fixture.txt; ‘z'", 'Write-Output "x”; Remove-Item fixture.txt; “z"',
    'C:\\Windows\\System32\\cmd.exe /c del fixture.txt',
  ];
  for (const command of writes) check('P09 explicit model misclassification cannot bypass a basic local veto: ' + command, !assess(command).readOnly);
  for (const command of [undefined, null, 1, {}, '', '  ', 'pwd ' + 'x'.repeat(16384)]) {
    check('P10 invalid command input fails closed', !assess(command).readOnly);
  }
  const explained = assess('docker ps', 'read_only', '只列出现有容器');
  check('P11 reasons preserve model provenance without claiming a sandbox', explained.reasons.some(reason => reason.includes('模型')) && explained.reasons.some(reason => reason.includes('只列出现有容器')));
  console.log(`\nRESULT ${checks} passed, 0 failed; no model/network/shell execution`);
} catch (error) { console.error('FAIL ' + (error.stack || error)); process.exitCode = 1; }
