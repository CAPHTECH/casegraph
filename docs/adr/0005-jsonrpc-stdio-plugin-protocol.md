# ADR-0005: JSON-RPC over stdio plugin protocol

- **Status:** Accepted
- **Date:** 2026-04-15

## Context

CaseGraph は public project として importer / sink / worker ecosystem を広げたい。  
特定言語の in-process plugin だけでは裾野が狭い。

一方で HTTP server 前提にすると local CLI の軽さが損なわれる。

## Decision

- plugin protocol は JSON-RPC 2.0 over stdio を基本とする
- importer / sink / worker は out-of-process で接続する
- capability discovery と health check を持つ

## Consequences

### Positive
- 言語非依存
- プロセス分離で failure isolation が効く
- CLI-first と相性が良い
- future MCP bridge を作りやすい

### Negative
- plugin 開発者は protocol 実装が必要
- stdin / stdout の扱いを誤るとデバッグしづらい
