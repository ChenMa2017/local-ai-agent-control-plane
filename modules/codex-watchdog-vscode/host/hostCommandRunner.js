"use strict";

function createHostCommandRunner({
  cp,
  os,
  getSafeOutput
}) {
  async function runLogged(command, args, options = {}) {
    const output = getSafeOutput();
    if (output && typeof output.show === "function") {
      output.show(true);
    }
    if (output) {
      output.appendLine(`$ ${[command, ...args].join(" ")}`);
    }
    const result = await run(command, args, options);
    if (output && result.stdout.trim()) {
      output.appendLine(result.stdout.trimEnd());
    }
    if (output && result.stderr.trim()) {
      output.appendLine(result.stderr.trimEnd());
    }
    return result;
  }

  async function runLoggedWithInput(command, args, input, options = {}) {
    const output = getSafeOutput();
    if (output && typeof output.show === "function") {
      output.show(true);
    }
    if (output) {
      output.appendLine(`$ ${[command, ...args].join(" ")} <stdin>`);
    }
    const result = await runWithInput(command, args, input, options);
    if (output && result.stdout.trim()) {
      output.appendLine(result.stdout.trimEnd());
    }
    if (output && result.stderr.trim()) {
      output.appendLine(result.stderr.trimEnd());
    }
    return result;
  }

  function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
      cp.execFile(command, args, {
        cwd: options.cwd || os.homedir(),
        env: { ...process.env, ...(options.env || {}) },
        timeout: options.timeout,
        maxBuffer: options.maxBuffer || 16 * 1024 * 1024
      }, (error, stdout, stderr) => {
        if (error && !options.allowFailure) {
          error.message = `${error.message}\n${stderr || ""}`.trim();
          reject(error);
          return;
        }
        resolve({ stdout: stdout || "", stderr: stderr || "", error });
      });
    });
  }

  function runWithInput(command, args, input, options = {}) {
    return new Promise((resolve, reject) => {
      const child = cp.spawn(command, args, {
        cwd: options.cwd || os.homedir(),
        env: { ...process.env, ...(options.env || {}) },
        stdio: ["pipe", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeoutId;

      const finish = (error, result) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (error && !options.allowFailure) {
          error.message = `${error.message}\n${stderr || ""}`.trim();
          reject(error);
          return;
        }
        resolve(result);
      };

      if (options.timeout) {
        timeoutId = setTimeout(() => {
          child.kill("SIGTERM");
          const error = new Error(`Command timed out after ${options.timeout} ms`);
          error.code = "ETIMEDOUT";
          finish(error, { stdout, stderr, error });
        }, options.timeout);
      }

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if ((options.maxBuffer || 16 * 1024 * 1024) < Buffer.byteLength(stdout + stderr, "utf8")) {
          child.kill("SIGTERM");
          const error = new Error("stdout/stderr maxBuffer exceeded");
          finish(error, { stdout, stderr, error });
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if ((options.maxBuffer || 16 * 1024 * 1024) < Buffer.byteLength(stdout + stderr, "utf8")) {
          child.kill("SIGTERM");
          const error = new Error("stdout/stderr maxBuffer exceeded");
          finish(error, { stdout, stderr, error });
        }
      });
      child.on("error", (error) => {
        finish(error, { stdout, stderr, error });
      });
      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        if ((code && code !== 0) || signal) {
          const error = new Error(signal ? `Command terminated by ${signal}` : `Command exited with status ${code}`);
          error.code = code;
          finish(error, { stdout, stderr, error });
          return;
        }
        finish(null, { stdout, stderr, error: null });
      });

      child.stdin.end(String(input || ""));
    });
  }

  return {
    run,
    runLogged,
    runLoggedWithInput
  };
}

module.exports = {
  createHostCommandRunner
};
