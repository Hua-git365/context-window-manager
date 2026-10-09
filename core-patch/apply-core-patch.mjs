#!/usr/bin/env node
/**
 * apply-core-patch.mjs —— 给 SillyTavern 内核打上 Context Window Manager 所需的补丁
 *
 * 背景
 *   这个扩展（以及它带来的「历史窗口策略可调」能力）依赖内核里的一个改动：
 *   `public/scripts/openai.js` 的 populateChatHistory() 本来把三个窗口策略参数硬编码在
 *   函数里，打了补丁之后改成从 `globalThis.STContextWindowPolicy` 读取 —— 也就是由本扩展
 *   在运行时写入。不装扩展时该对象不存在，内核回退到原来的常量，行为与官方版本一致。
 *
 *   所以：扩展本体可以走 ST 的「Install Extension」，但内核这块改不了，必须在本机执行一次。
 *
 * 用法
 *   node apply-core-patch.mjs                 # 自动定位 ST 根目录并打补丁
 *   node apply-core-patch.mjs --check         # 只报告状态，不修改任何文件
 *   node apply-core-patch.mjs --dry-run       # 显示将要发生的替换，不写盘
 *   node apply-core-patch.mjs --revert        # 从最近一次备份还原
 *   node apply-core-patch.mjs --list          # 列出补丁条目
 *   node apply-core-patch.mjs --root <路径>   # 手动指定 ST 根目录
 *
 * 安全性
 *   - 所有替换先在内存里完整校验（必须每条都唯一命中）才会写盘，任何一条失败就整体放弃；
 *   - 写盘前自动备份为 openai.js.bak.<时间戳>；
 *   - 幂等：已经打过补丁的文件会被识别出来并跳过；
 *   - 保留原文件的换行风格（LF/CRLF）与 BOM。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATCH_FILE = path.join(HERE, 'sticky-history-window.json');
const LOG = '[core-patch]';

const argv = process.argv.slice(2);

function flag(name) {
    return argv.includes('--' + name);
}

function option(name) {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : undefined;
}

function ok(msg) { console.log(`  ✓ ${msg}`); }
function bad(msg) { console.log(`  ✗ ${msg}`); }
function info(msg) { console.log(`${LOG} ${msg}`); }
function warn(msg) { console.log(`${LOG} ⚠ ${msg}`); }

/** 从脚本自身位置、显式参数、当前目录三个方向寻找 ST 根目录（含 public/scripts/openai.js 的目录）。 */
function findRoot(explicit) {
    const seen = new Set();
    const candidates = [];

    const push = dir => {
        const abs = path.resolve(dir);
        if (!seen.has(abs)) {
            seen.add(abs);
            candidates.push(abs);
        }
    };

    if (explicit) {
        push(explicit);
    }

    // 从脚本所在目录逐级向上
    let dir = HERE;
    for (let i = 0; i < 10; i++) {
        push(dir);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    // 从当前工作目录逐级向上
    let cwd = process.cwd();
    for (let i = 0; i < 6; i++) {
        push(cwd);
        const parent = path.dirname(cwd);
        if (parent === cwd) break;
        cwd = parent;
    }

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'public', 'scripts', 'openai.js'))) {
            return candidate;
        }
    }
    return null;
}

function detectEol(text) {
    const crlf = (text.match(/\r\n/g) || []).length;
    const lf = (text.match(/\n/g) || []).length - crlf;
    return crlf > lf ? '\r\n' : '\n';
}

function readText(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const bom = raw.startsWith('\uFEFF');
    const body = bom ? raw.slice(1) : raw;
    return { body, bom, eol: detectEol(body) };
}

function writeText(file, body, bom, eol) {
    const normalized = body.replace(/\r\n/g, '\n').split('\n').join(eol);
    fs.writeFileSync(file, (bom ? '\uFEFF' : '') + normalized, 'utf8');
}

function loadPatchSet() {
    if (!fs.existsSync(PATCH_FILE)) {
        console.error(`${LOG} 找不到补丁数据文件：${PATCH_FILE}`);
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(PATCH_FILE, 'utf8'));
}

function listPatches(set) {
    console.log(`${LOG} ${set.title}`);
    console.log(`${LOG} 目标文件：${set.targetFile}   对应上游：${set.upstreamRef}`);
    for (const p of set.patches) {
        console.log(`   - ${p.id}  (${p.upstreamHeader})`);
    }
}

function newestBackup(file) {
    const dir = path.dirname(file);
    const base = path.basename(file) + '.bak.';
    const found = fs.readdirSync(dir)
        .filter(name => name.startsWith(base))
        .sort()
        .reverse();
    return found.length ? path.join(dir, found[0]) : null;
}

function main() {
    const set = loadPatchSet();

    if (flag('list')) {
        listPatches(set);
        return;
    }

    const root = findRoot(option('root'));
    if (!root) {
        console.error(`${LOG} 没能定位 SillyTavern 根目录（找不到 public/scripts/openai.js）。`);
        console.error(`${LOG} 请在 ST 根目录下运行，或用 --root <路径> 指定。`);
        process.exit(1);
    }

    const target = path.join(root, set.targetFile);
    if (!fs.existsSync(target)) {
        console.error(`${LOG} 目标文件不存在：${target}`);
        process.exit(1);
    }

    info(`SillyTavern 根目录：${root}`);

    if (flag('revert')) {
        const backup = newestBackup(target);
        if (!backup) {
            bad('没有找到任何备份文件，无法回滚');
            process.exit(1);
        }
        const { body, bom, eol } = readText(backup);
        writeText(target, body, bom, eol);
        ok(`已从备份还原：${path.basename(backup)}`);
        return;
    }

    const { body, bom, eol } = readText(target);
    const normalized = body.replace(/\r\n/g, '\n');

    if (normalized.includes(set.appliedMarker)) {
        ok(`已经打过补丁（找到标记 ${set.appliedMarker}），无需重复应用`);
        const leftovers = set.patches.filter(p => normalized.includes(p.old.replace(/\r\n/g, '\n')));
        if (leftovers.length) {
            warn(`仍有 ${leftovers.length} 条原始代码残留：${leftovers.map(p => p.id).join(', ')}`);
        }
        return;
    }

    // ---- 先在内存里完整校验，任何一条不满足就整体放弃 ----
    const problems = [];
    const plan = [];

    for (const p of set.patches) {
        const oldText = p.old.replace(/\r\n/g, '\n');
        const first = normalized.indexOf(oldText);
        if (first < 0) {
            problems.push(`${p.id}: 找不到待替换的原始代码（上游版本 ${set.upstreamRef} 之外？）`);
            continue;
        }
        if (normalized.indexOf(oldText, first + 1) >= 0) {
            problems.push(`${p.id}: 原始代码出现多次，无法确定替换位置`);
            continue;
        }
        plan.push({ id: p.id, oldText, newText: p.new.replace(/\r\n/g, '\n'), at: first });
    }

    if (problems.length) {
        bad('校验未通过，未做任何修改：');
        for (const line of problems) console.log(`     - ${line}`);
        console.error(`${LOG} 这通常意味着本机的 openai.js 不是 ${set.upstreamRef} 的版本。`);
        console.error(`${LOG} 可以手动对照 core-patch/sticky-history-window.patch 应用，或用 --dry-run 查看预期。`);
        process.exit(2);
    }

    ok(`校验通过：${plan.length} 条替换全部唯一命中`);

    if (flag('dry-run') || flag('check')) {
        for (const item of plan) {
            const line = normalized.slice(0, item.at).split('\n').length;
            console.log(`     · ${item.id}  在第 ${line} 行附近，替换 ${item.oldText.split('\n').length} 行 -> ${item.newText.split('\n').length} 行`);
        }
        if (flag('check')) {
            info('当前状态：未打补丁');
        } else {
            info('--dry-run：未写入任何文件');
        }
        return;
    }

    // ---- 应用 ----
    let result = normalized;
    for (const item of plan) {
        const at = result.indexOf(item.oldText);
        result = result.slice(0, at) + item.newText + result.slice(at + item.oldText.length);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backup = `${target}.bak.${stamp}`;
    fs.copyFileSync(target, backup);
    ok(`已备份：${path.basename(backup)}`);

    writeText(target, result, bom, eol);
    ok(`已写入：${set.targetFile}`);

    // ---- 写后复验 ----
    const check = readText(target).body.replace(/\r\n/g, '\n');
    const markerOk = check.includes(set.appliedMarker);
    const residue = set.patches.filter(p => check.includes(p.old.replace(/\r\n/g, '\n')));
    if (!markerOk || residue.length) {
        bad('写后复验失败，正在回滚');
        writeText(target, body, bom, eol);
        process.exit(3);
    }

    ok('写后复验通过');
    console.log('');
    info('完成。public/ 下的改动刷新浏览器即可生效（无需重启 Node 进程）。');
    info('想撤销：node apply-core-patch.mjs --revert');
}

main();
