/* Model-led command classification with a small local veto, not a shell sandbox.
 * Unknown CLIs can be read-only when the model explicitly classifies them so.
 * Environment, executable identity, configuration and remote effects are outside
 * this textual check; execution time/output limits and ordinary approvals remain.
 */
(function () {
  'use strict';
  const words = value => new Set(value.split(' '));
  const writers = words('rm rmdir unlink mv cp install mkdir touch truncate dd tee ln chmod chown chgrp setfacl chattr fallocate shred split csplit sync reboot shutdown poweroff halt kill killall pkill mount umount swapon swapoff mkswap mkfs fdisk sfdisk parted growpart resize2fs tune2fs cryptsetup lvcreate lvremove lvresize lvextend lvreduce vgcreate vgremove pvcreate pvremove del erase rd copy move ren rename remove-item set-content add-content new-item out-file copy-item move-item rename-item clear-content clear-item set-item set-itemproperty new-itemproperty remove-itemproperty rename-itemproperty clear-itemproperty set-acl stop-process stop-service restart-service start-service set-service new-service remove-service');
  const opaque = words('sudo su doas env command builtin exec eval source . sh bash dash zsh ksh csh tcsh fish powershell pwsh cmd python python2 python3 node nodejs deno bun perl ruby php lua awk gawk mawk sed xargs busybox toybox nohup timeout nice time watch ssh scp sftp rsync socat nc ncat netcat telnet ftp wget npx invoke-command invoke-expression start-process start-job iex icm saps');
  const mutations = words('add append apply build clean clone commit cp create delete del deploy destroy disable down drain edit enable exec import init install join kill label leave load login logout merge mount move mv patch pause prune pull push rebase rebuild reconcile reload remove rename replace reset restart restore revert rm rollback run scale set start stop switch tag taint uncordon uninstall unlink unload unmount unpause update upgrade up upload use write use-context set-context set-cluster set-credentials unset-context rename-context delete-context delete-cluster delete-user');
  const systemQueries = words('status show is-active is-enabled is-failed list-units list-unit-files list-jobs list-timers list-sockets list-dependencies get-default cat');
  const gitWrites = words('add am apply bisect checkout cherry-pick clean clone commit config fetch format-patch gc init merge mv pull push rebase repack reset restore revert rm stash submodule switch update-index update-ref worktree maintenance prune reflog notes replace sparse-checkout');
  const baseName = value => String(value).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
  const utf8Bytes = value => { let bytes = 0; for (const char of value) { const cp = char.codePointAt(0); bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4; } return bytes; };

  function tokenize(command) {
    if (typeof command !== 'string' || !command.trim() || command.length > 16384) throw new Error('命令为空、不是文本或超过长度限制');
    if (/[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/.test(command)) throw new Error('命令包含换行或控制字符，需要确认');
    if (/[\u2018\u2019\u201c\u201d]/.test(command)) throw new Error('不同 shell 对智能引号的解释不同，需要确认');
    if (/^\s*(?:[A-Za-z]:\\|\\\\)/.test(command)) throw new Error('跨平台可执行路径需要确认');
    const tokens = []; let token = '', quote = '', active = false;
    const finish = () => { if (active) tokens.push(token); token = ''; active = false; };
    for (let i = 0; i < command.length; i++) {
      const char = command[i];
      if (quote === "'") { if (char === "'") quote = ''; else token += char; continue; }
      if (quote === '"') {
        if (char === '"') { quote = ''; continue; }
        if (char === '$' || char === '`') throw new Error('包含变量或命令替换，需要确认');
        if (char === '\\') {
          if (++i >= command.length) throw new Error('转义未完成，需要确认');
          const next = command[i];
          if (';|&<>()\'"`$'.includes(next)) throw new Error('不同 shell 对特殊字符转义的解释不同，需要确认');
          token += '$`"\\'.includes(next) ? next : '\\' + next;
        } else token += char;
        continue;
      }
      if (char === ' ' || char === '\t') { finish(); continue; }
      if (char === "'" || char === '"') { quote = char; active = true; continue; }
      if (char === '\\') {
        if (++i >= command.length) throw new Error('转义未完成，需要确认');
        if (';|&<>()\'"`$'.includes(command[i])) throw new Error('不同 shell 对特殊字符转义的解释不同，需要确认');
        token += command[i]; active = true; continue;
      }
      if (';|&<>()'.includes(char)) throw new Error('复合命令、管道或重定向需要确认');
      if (char === '$' || char === '`') throw new Error('包含变量或命令替换，需要确认');
      if ('*?[]{}~!'.includes(char)) throw new Error('包含动态 shell 展开，需要确认');
      if (char === '#' && !active) throw new Error('带 shell 注释的命令需要确认');
      token += char; active = true;
    }
    if (quote) throw new Error('引号未闭合，需要确认');
    finish(); if (!tokens.length || !tokens[0]) throw new Error('未能识别命令，需要确认');
    return tokens;
  }

  // Match a dangerous long option and its getopt-style abbreviated spelling.
  const longFlag = (arg, names) => {
    if (!arg.startsWith('--') || arg === '--') return false;
    const name = arg.slice(2).split('=')[0];
    return !!name && names.some(full => full.startsWith(name));
  };
  function hasFlag(args, longNames = [], shortNames = '', valueShorts = '') {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]; if (arg === '--') break;
      if (longFlag(arg, longNames)) return true;
      if (arg.startsWith('-') && !arg.startsWith('--')) {
        for (let j = 1; j < arg.length; j++) {
          if (shortNames.includes(arg[j])) return true;
          if (valueShorts.includes(arg[j])) { if (j === arg.length - 1) i++; break; }
        }
      }
    }
    return false;
  }
  function verbAt(args, valueOptions = []) {
    const takesValue = new Set(valueOptions);
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--') return { word: args[i + 1] || '', index: i + 1 };
      if (!arg.startsWith('-') || arg === '-') return { word: arg, index: i };
      if (takesValue.has(arg) || arg.startsWith('--') && !arg.includes('=') && valueOptions.some(full => full.startsWith(arg))) i++;
    }
    return { word: '', index: args.length };
  }

  function localVeto(tokens) {
    const command = baseName(tokens[0]), args = tokens.slice(1);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return '环境赋值或执行前缀需要确认';
    if (writers.has(command) || /^(?:mkfs\.|fsck(?:\.|$))/.test(command)) return '本地识别到文件、系统或进程修改命令';
    if (opaque.has(command) || /^python\d+(?:\.\d+)?$/.test(command)) return '解释器、执行包装器或传输命令需要确认';
    if (command === 'hostname' && (args.some(arg => !arg.startsWith('-')) || hasFlag(args, ['file', 'boot'], 'Fb'))) return '设置主机名的命令需要确认';
    if (command === 'sort' && hasFlag(args, ['output'], 'o')) return 'sort 输出文件需要确认';
    if (command === 'uniq') {
      let operands = 0;
      for (let i = 0; i < args.length; i++) {
        if (['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'].includes(args[i])) { i++; continue; }
        if (args[i] === '--') { operands += args.length - i - 1; break; }
        if (!args[i].startsWith('-') || args[i] === '-') operands++;
      }
      if (operands > 1) return 'uniq 输出文件需要确认';
    }
    if (command === 'ss' && hasFlag(args, ['kill', 'diag', 'filter'], 'KDF')) return '关闭连接或读写诊断文件需要确认';
    if (command === 'df' && hasFlag(args, ['sync'])) return '显式磁盘同步需要确认';
    if (command === 'find') {
      const values = words('-name -iname -path -ipath -wholename -iwholename -regex -iregex -type -xtype -user -group -uid -gid -size -mtime -atime -ctime -mmin -amin -cmin -newer -anewer -cnewer -samefile -maxdepth -mindepth -fstype -perm -links -inum -used -context');
      for (let i = 0; i < args.length; i++) {
        if (values.has(args[i])) { i++; continue; }
        if (/^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(args[i])) return 'find 的执行或写入动作需要确认';
      }
    }
    if (command === 'systemctl') {
      const verb = verbAt(args, ['--property', '-p', '--type', '-t', '--state']).word;
      if (!systemQueries.has(verb) || !args.includes('--no-pager')) return 'systemctl 仅在明确查询且带 --no-pager 时自动执行';
      if (hasFlag(args, ['host', 'machine', 'root', 'image', 'message', 'boot-loader-entry', 'boot-loader-menu', 'firmware-setup', 'when'], 'HM')) return 'systemctl 跨主机、启动设置或附带操作需要确认';
    }
    if (command === 'journalctl') {
      if (!args.includes('--no-pager') || hasFlag(args, ['rotate', 'vacuum-size', 'vacuum-time', 'vacuum-files', 'flush', 'sync', 'relinquish-var', 'smart-relinquish-var', 'update-catalog', 'setup-keys'])) return 'journalctl 维护操作或未禁用分页器的命令需要确认';
    }
    if (command === 'ip') {
      if (hasFlag(args, ['batch', 'force']) || args.some(arg => /^-(?:b|batch|force)/.test(arg) && !['-br', '-brief'].includes(arg))) return 'ip 批处理命令需要确认';
      const object = verbAt(args, ['-family', '-f', '-netns', '-n']);
      const action = verbAt(args.slice(object.index + 1)).word;
      if (action && !['show', 'list', 'get', 'help'].includes(action)) return 'ip 非明确查询操作需要确认';
    }
    if (command === 'git') {
      const verb = verbAt(args, ['-c', '-C', '--config-env', '--git-dir', '--work-tree', '--exec-path']);
      if (hasFlag(args.slice(0, verb.index), ['config-env', 'exec-path', 'git-dir', 'work-tree'], 'cC')) return 'Git 配置或执行上下文覆盖需要确认';
      if (gitWrites.has(verb.word)) return 'Git 修改、配置或下载操作需要确认';
      const rest = args.slice(verb.index + 1);
      if (hasFlag(rest, ['output', 'ext-diff', 'textconv', 'show-signature', 'exec'], '', 'UnmLSG')) return 'Git 写文件或外部程序选项需要确认';
      if (verb.word === 'archive' && hasFlag(rest, ['output'], 'o') || verb.word === 'hash-object' && hasFlag(rest, [], 'w')) return 'Git 输出文件或对象写入需要确认';
      if (verb.word === 'branch' && (hasFlag(rest, ['delete', 'move', 'copy', 'edit-description', 'set-upstream-to', 'unset-upstream'], 'dDmMcC') || rest.some(arg => !arg.startsWith('-')) && !rest.includes('--list'))) return 'Git 分支修改需要确认';
      if (verb.word === 'tag' && (hasFlag(rest, ['delete', 'annotate', 'sign', 'force'], 'dasf') || rest.some(arg => !arg.startsWith('-')) && !rest.includes('--list') && !rest.includes('-l'))) return 'Git 标签修改需要确认';
      if (verb.word === 'remote' && rest.some(arg => !arg.startsWith('-')) && !['get-url'].includes(verbAt(rest).word)) return 'Git 远端配置或连接操作需要确认';
    }
    if (command === 'curl' && hasFlag(args, ['output', 'remote-name', 'output-dir', 'upload-file', 'data', 'data-raw', 'data-binary', 'data-urlencode', 'json', 'form', 'cookie-jar', 'dump-header', 'trace', 'trace-ascii', 'config', 'libcurl', 'hsts', 'alt-svc', 'request'], 'oOTdFcDKX')) return 'curl 写文件、提交数据或配置驱动请求需要确认';
    if (command === 'docker' || command === 'podman' || command === 'kubectl' || command === 'oc') {
      const values = ['--context', '--config', '--host', '-H', '--log-level', '-l', '--namespace', '-n', '--kubeconfig', '--server', '-s', '--user', '--cluster', '--tlscacert', '--tlscert', '--tlskey', '--cache-dir'];
      let verb = verbAt(args, values);
      if (['container', 'image', 'volume', 'network', 'system', 'builder', 'buildx', 'context', 'compose', 'swarm', 'service', 'stack', 'plugin', 'secret', 'config', 'trust', 'node', 'rollout', 'auth', 'certificate'].includes(verb.word)) verb = verbAt(args.slice(verb.index + 1), values);
      if (mutations.has(verb.word) || ['attach', 'port-forward', 'proxy', 'cordon', 'debug', 'undo', 'resume', 'suspend', 'unset'].includes(verb.word)) return '容器或集群修改、执行或连接操作需要确认';
    }
    if (['apt', 'apt-get', 'yum', 'dnf', 'pacman', 'brew', 'npm', 'pip', 'pip3', 'gem', 'cargo', 'terraform', 'helm'].includes(command)) {
      if (['pip', 'pip3'].includes(command) && hasFlag(args, ['log'])) return '显式日志文件写入需要确认';
      const verb = verbAt(args, ['--prefix', '--namespace', '-n', '--kube-context', '--kubeconfig', '--config', '--config-file', '-c', '--cache-dir', '--root', '--target', '--directory', '-C', '-o', '--option', '-t', '--target-release', '--installroot', '--releasever', '--repo', '--setopt', '--dbpath', '--cachedir']).word;
      if (mutations.has(verb) || ['autoremove', 'dist-upgrade', 'full-upgrade', 'publish', 'link', 'ci', 'pack', 'script', 'scripts', 'destroy', 'import', 'taint', 'untaint'].includes(verb)) return '安装、发布或基础设施修改操作需要确认';
    }
    if (['iptables', 'ip6tables'].includes(command) && hasFlag(args, ['append', 'delete', 'insert', 'replace', 'flush', 'zero', 'new-chain', 'delete-chain', 'policy', 'rename-chain'], 'ADIRFZNXPE')) return '防火墙修改需要确认';
    if (command === 'nft' && (hasFlag(args, ['file', 'interactive'], 'fi') || ['add', 'delete', 'insert', 'replace', 'flush', 'reset'].includes(verbAt(args).word))) return '防火墙脚本或修改需要确认';
    if (command === 'sysctl' && (hasFlag(args, ['write', 'load', 'system'], 'wp') || args.some(arg => !arg.startsWith('-') && arg.includes('=')))) return '内核参数写入需要确认';
    return null;
  }

  function assess(command, effect, reason) {
    if (!['read_only', 'modify', 'unknown'].includes(effect)) return { readOnly: false, reasons: ['模型未提供有效的操作分类，需要确认'] };
    if (reason != null && (typeof reason !== 'string' || utf8Bytes(reason) > 1024 || /[\x00-\x1f\x7f-\x9f]/.test(reason))) return { readOnly: false, reasons: ['模型分类理由格式无效，需要确认'] };
    const reasons = reason ? ['模型说明：' + reason] : [];
    if (effect !== 'read_only') return { readOnly: false, reasons: [effect === 'modify' ? '模型判定为修改操作，需要确认' : '模型无法明确判定为只读，需要确认', ...reasons] };
    try {
      const veto = localVeto(tokenize(command));
      if (veto) return { readOnly: false, reasons: [veto, ...reasons] };
      return { readOnly: true, reasons: ['模型判定为只读，未命中本地基础修改拦截', ...reasons] };
    } catch (error) { return { readOnly: false, reasons: [error.message || '无法解析命令，需要确认', ...reasons] }; }
  }

  window.AiCommandPolicy = Object.freeze({ assess });
})();
