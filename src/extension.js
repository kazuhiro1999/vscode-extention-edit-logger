"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// 学生のログを保存するためのクラス
class StudentLogger {
    logFolder;
    sessionId;
    studentId;
    currentDocument;
    logFile;
    editLog;
    errorLog;
    constructor() {
        // 初期設定
        this.logFolder = path.join(vscode.workspace.rootPath || '', '.student-logs');
        this.sessionId = this.generateSessionId();
        this.studentId = vscode.workspace.getConfiguration('studentLogger').get('studentId') || 'anonymous';
        this.currentDocument = '';
        this.logFile = '';
        this.editLog = [];
        this.errorLog = [];
        // ログフォルダの作成
        this.ensureLogFolder();
    }
    // セッションIDの生成
    generateSessionId() {
        const now = new Date();
        return `session_${now.getFullYear()}${this.padZero(now.getMonth() + 1)}${this.padZero(now.getDate())}_${this.padZero(now.getHours())}${this.padZero(now.getMinutes())}${this.padZero(now.getSeconds())}`;
    }
    // 数値を2桁の文字列にパディング
    padZero(num) {
        return num < 10 ? `0${num}` : `${num}`;
    }
    // ログフォルダの確認と作成
    ensureLogFolder() {
        if (!fs.existsSync(this.logFolder)) {
            fs.mkdirSync(this.logFolder, { recursive: true });
        }
    }
    // ドキュメントの変更時に呼び出される
    onDocumentChange(document) {
        const fileName = document.fileName;
        if (this.currentDocument !== fileName) {
            this.currentDocument = fileName;
            this.logFile = path.join(this.logFolder, `${this.studentId}_${path.basename(fileName)}_${this.sessionId}.json`);
            this.saveLog();
        }
    }
    // 編集履歴の記録
    logEdit(edit, document) {
        const now = new Date();
        const editInfo = {
            timestamp: now.toISOString(),
            range: {
                start: {
                    line: edit.range.start.line,
                    character: edit.range.start.character
                },
                end: {
                    line: edit.range.end.line,
                    character: edit.range.end.character
                }
            },
            text: edit.text,
            isDelete: edit.text === '',
            isReplace: edit.rangeLength > 0 && edit.text !== '',
            isInsert: edit.rangeLength === 0 && edit.text !== '',
            lineContent: document.lineAt(edit.range.start.line).text
        };
        this.editLog.push(editInfo);
        this.saveLog();
    }
    // エラー情報の記録
    logError(error, code) {
        const now = new Date();
        const errorInfo = {
            timestamp: now.toISOString(),
            message: error.message || 'Unknown error',
            stack: error.stack,
            code: code
        };
        this.errorLog.push(errorInfo);
        this.saveLog();
    }
    // キーボード入力の記録
    logKeyInput(key, document) {
        const now = new Date();
        const position = vscode.window.activeTextEditor?.selection.active;
        if (!position)
            return;
        const keyInfo = {
            timestamp: now.toISOString(),
            key: key,
            position: {
                line: position.line,
                character: position.character
            },
            lineContent: document.lineAt(position.line).text
        };
        this.editLog.push(keyInfo);
        // 頻繁なファイル書き込みを避けるため、キー入力はバッファリングする
        if (this.editLog.length % 10 === 0) {
            this.saveLog();
        }
    }
    // ログの保存
    saveLog() {
        if (!this.logFile)
            return;
        const logData = {
            studentId: this.studentId,
            sessionId: this.sessionId,
            fileName: this.currentDocument,
            editLog: this.editLog,
            errorLog: this.errorLog
        };
        fs.writeFileSync(this.logFile, JSON.stringify(logData, null, 2));
    }
    // デバッグセッション開始時のコード記録
    logDebugSession(document) {
        const now = new Date();
        const debugInfo = {
            timestamp: now.toISOString(),
            event: 'debug_start',
            code: document.getText()
        };
        this.errorLog.push(debugInfo);
        this.saveLog();
    }
}
// 拡張機能のアクティベーション
function activate(context) {
    console.log('Student Logger extension is now active!');
    const studentLogger = new StudentLogger();
    // ドキュメント変更イベントの監視
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
        studentLogger.onDocumentChange(e.document);
        e.contentChanges.forEach(change => {
            studentLogger.logEdit(change, e.document);
        });
    }));
    // キーボード入力イベントの監視
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(e => {
        const document = e.textEditor.document;
        if (document) {
            studentLogger.onDocumentChange(document);
        }
    }));
    // デバッグセッション開始イベントの監視
    context.subscriptions.push(vscode.debug.onDidStartDebugSession(session => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            studentLogger.logDebugSession(editor.document);
        }
    }));
    // デバッグ出力イベントの監視
    context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
        if (event.event === 'output') {
            const output = event.body;
            if (output.category === 'stderr') {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    studentLogger.logError({
                        message: output.output,
                        stack: null
                    }, editor.document.getText());
                }
            }
        }
    }));
    // 表示コマンドの登録
    const disposable = vscode.commands.registerCommand('extension.studentLogger.showStats', () => {
        vscode.window.showInformationMessage('Student logger is active. Logs are being collected.');
    });
    context.subscriptions.push(disposable);
}
exports.activate = activate;
// 拡張機能の非アクティベーション
function deactivate() {
    console.log('Student Logger extension is now deactivated.');
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map