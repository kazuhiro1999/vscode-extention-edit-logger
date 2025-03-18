import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';

// 学生のログを保存するためのインターフェース
interface LogEntry {
    timestamp: string;
}

// 編集ログのインターフェース
interface EditLogEntry extends LogEntry {
    range?: {
        start: { line: number; character: number };
        end: { line: number; character: number };
    };
    text?: string;
    operation?: string;
    lineContent?: string;
    key?: string;
    position?: { line: number; character: number };
}

// エラーログのインターフェース
interface ErrorLogEntry extends LogEntry {
    message: string;
    stack: string | null;
    code?: string;
    event?: string;
    language?: string;
}

// キー入力ログのインターフェース
interface KeyLogEntry extends LogEntry {
    key: string;
    position: { line: number; character: number };
    lineContent: string;
}

// 実行ログのインターフェース
interface ExecutionLogEntry extends LogEntry {
    event: string;
    file: string;
    language: string;
    output?: string;
    error?: string;
    exitCode?: number;
    duration?: number;
}

// ログを保存するためのクラス
class Logger {
    private logFolder: string;
    private sessionId: string;
    private studentId: string;
    private currentDocument: string;
    private logFile: string;
    private editLog: EditLogEntry[];
    private errorLog: ErrorLogEntry[];
    private executionLog: ExecutionLogEntry[];
    private isSaving: boolean;
    private saveTimeout: NodeJS.Timeout | null;
    private currentExecution: {
        startTime: number;
        file: string;
        process?: cp.ChildProcess;
        output: string;
        error: string;
    } | null;

    constructor() {
        // 初期設定
        this.logFolder = this.getLogFolderPath();
        this.sessionId = this.generateSessionId();
        this.studentId = vscode.workspace.getConfiguration('Logger').get('studentId') || 'anonymous';
        this.currentDocument = '';
        this.logFile = '';
        this.editLog = [];
        this.errorLog = [];
        this.executionLog = [];
        this.isSaving = false;
        this.saveTimeout = null;
        this.currentExecution = null;
        
        // ログフォルダの作成
        this.ensureFolder(this.logFolder);
    }

    // ログフォルダのパスを取得する
    private getLogFolderPath(): string {
        // ワークスペースフォルダが存在するか確認
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            // 最初のワークスペースフォルダを使用
            const workspaceFolder = vscode.workspace.workspaceFolders[0];
            return path.join(workspaceFolder.uri.fsPath, '.logs');
        } else {
            // ワークスペースがない場合は一時ディレクトリを使用
            return path.join(os.tmpdir(), '.logs');
        }
    }

    // セッションIDの生成
    private generateSessionId(): string {
        const now = new Date();
        return `session_${now.getFullYear()}${this.padZero(now.getMonth() + 1)}${this.padZero(now.getDate())}_${this.padZero(now.getHours())}${this.padZero(now.getMinutes())}${this.padZero(now.getSeconds())}`;
    }

    // 数値を2桁の文字列にパディング
    private padZero(num: number): string {
        return String(num).padStart(2, "0");
    }

    // 現在のタイムスタンプを取得
    private getCurrentTimestamp(): string {
        return new Date().toISOString();
    }

    // 生徒情報のリロード
    public loadStudentId(): void {
        this.studentId = vscode.workspace.getConfiguration('Logger').get('studentId') || 'anonymous';
    }

    // ドキュメントの変更時に呼び出される
    public onDocumentChange(document: vscode.TextDocument): void {
        const fileName = document.fileName;

        // ログファイル、出力チャネル、ターミナルは無視する
        if (this.shouldIgnoreDocument(document)) {
            return;
        }

        if (this.currentDocument !== fileName) {
            this.currentDocument = fileName;
            
            const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
            let folderPath = this.logFolder;
            
            // 文書がワークスペースに属する場合、そのワークスペース内のログフォルダを使用
            if (workspaceFolder) {
                folderPath = path.join(workspaceFolder.uri.fsPath, '.logs');
                // フォルダが存在することを確認
                this.ensureFolder(folderPath);
            }
            
            this.logFile = path.join(folderPath, `${this.studentId}_${path.basename(fileName)}_${this.sessionId}.json`);
            this.saveLog();
        }
    }

    // 無視すべきドキュメントかどうかをチェックする
    public shouldIgnoreDocument(document: vscode.TextDocument): boolean {
        const fileName = document.fileName;
        
        // ログファイルのチェック
        const isLogFile = fileName.includes('.logs') || 
                        fileName.endsWith('.json') && (
                            fileName.includes(`_${this.sessionId}.json`) || 
                            fileName.includes(`${this.studentId}_`)
                        );
        
        // 出力チャネルやターミナルのチェック（出力チャネルのURIスキームは通常 'output' や 'terminal'）
        const isOutputOrTerminal = document.uri.scheme === 'output' || 
                                document.uri.scheme === 'terminal' ||
                                fileName.includes('extension-output') ||
                                fileName.includes('Python Execution Log');
        
        return isLogFile || isOutputOrTerminal;
    }

    // フォルダ存在確認と作成
    private ensureFolder(folderPath: string): void {
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }
    }

    // 編集履歴の記録
    public logEdit(edit: vscode.TextDocumentContentChangeEvent, document: vscode.TextDocument): void {
        const editInfo: EditLogEntry = {
            timestamp: this.getCurrentTimestamp(),
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
            operation: edit.text === '' ? 'delete' : (edit.rangeLength > 0 && edit.text !== '') ? 'replace' : 'insert',
            lineContent: document.lineAt(edit.range.start.line).text
        };
        this.editLog.push(editInfo);
        this.scheduleSave();
    }

    // エラー情報の記録
    public logError(error: any, code: string, language?: string): void {
        const errorInfo: ErrorLogEntry = {
            timestamp: this.getCurrentTimestamp(),
            message: error.message || 'Unknown error',
            stack: error.stack,
            code: code,
            language: language
        };
        this.errorLog.push(errorInfo);
        this.scheduleSave();
    }

    // キーボード入力の記録
    public logKeyInput(key: string, document: vscode.TextDocument): void {
        const position = vscode.window.activeTextEditor?.selection.active;
        if (!position) return;

        const keyInfo: KeyLogEntry = {
            timestamp: this.getCurrentTimestamp(),
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
            this.scheduleSave();
        }
    }

    // Pythonファイル実行開始の記録
    public startPythonExecution(filePath: string): void {
        // 現在実行中のプロセスがある場合は終了させる
        if (this.currentExecution) {
            if (this.currentExecution.process) {
                this.currentExecution.process.kill();
            }
            this.finishExecution(1, 'Aborted by new execution');
        }

        this.currentExecution = {
            startTime: Date.now(),
            file: filePath,
            output: '',
            error: ''
        };

        // 現在のドキュメントが実行されたファイルと異なる場合は更新
        const document = vscode.workspace.textDocuments.find(doc => doc.fileName === filePath);
        if (document) {
            this.onDocumentChange(document);
        }

        // 実行開始ログ
        const executionInfo: ExecutionLogEntry = {
            timestamp: this.getCurrentTimestamp(),
            event: 'execution_start',
            file: filePath,
            language: 'python'
        };
        this.executionLog.push(executionInfo);
        this.scheduleSave();
    }

    // Python実行のプロセスを設定
    public setPythonProcess(process: cp.ChildProcess): void {
        if (!this.currentExecution) {
            return;
        }

        this.currentExecution.process = process;

        // 標準出力をリッスン
        process.stdout?.on('data', (data: Buffer) => {
            const output = data.toString();
            if (this.currentExecution) {
                this.currentExecution.output += output;
            }
        });

        // 標準エラー出力をリッスン
        process.stderr?.on('data', (data: Buffer) => {
            const error = data.toString();
            if (this.currentExecution) {
                this.currentExecution.error += error;
            }
        });

        // プロセス終了イベント
        process.on('exit', (code: number | null) => {
            this.finishExecution(code || 0);
        });

        // エラーイベント
        process.on('error', (err: Error) => {
            if (this.currentExecution) {
                this.currentExecution.error += err.message;
            }
            this.finishExecution(1, err.message);
        });
    }

    // Python実行終了の記録
    private finishExecution(exitCode: number, errorMessage?: string): void {
        if (!this.currentExecution) {
            return;
        }

        const duration = Date.now() - this.currentExecution.startTime;
        
        const executionInfo: ExecutionLogEntry = {
            timestamp: this.getCurrentTimestamp(),
            event: 'execution_end',
            file: this.currentExecution.file,
            language: 'python',
            output: this.currentExecution.output,
            error: this.currentExecution.error || errorMessage,
            exitCode: exitCode,
            duration: duration
        };
        
        this.executionLog.push(executionInfo);
        
        // エラーがあった場合はエラーログにも記録
        if (exitCode !== 0 || this.currentExecution.error || errorMessage) {
            this.logPythonError(this.currentExecution.file, this.currentExecution.error || errorMessage || 'Unknown error');
        }
        
        this.currentExecution = null;
        this.scheduleSave();
    }

    // Python実行エラーの記録
    private logPythonError(filePath: string, errorMessage: string): void {
        // Pythonのエラー情報からスタックトレースを抽出
        const errorLines = errorMessage.split('\n');
        let errorStack = null;
        
        if (errorLines.length > 1) {
            // 最初の行をエラーメッセージ、残りをスタックとして扱う
            const message = errorLines[0];
            errorStack = errorLines.slice(1).join('\n');
            
            const errorInfo: ErrorLogEntry = {
                timestamp: this.getCurrentTimestamp(),
                message: message,
                stack: errorStack,
                code: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '',
                event: 'python_execution_error',
                language: 'python'
            };
            
            this.errorLog.push(errorInfo);
        } else {
            // エラー行が1行のみの場合
            const errorInfo: ErrorLogEntry = {
                timestamp: this.getCurrentTimestamp(),
                message: errorMessage,
                stack: null,
                code: fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '',
                event: 'python_execution_error',
                language: 'python'
            };
            
            this.errorLog.push(errorInfo);
        }
    }

    // 保存のスケジュール
    private scheduleSave(): void {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        
        this.saveTimeout = setTimeout(() => {
            this.saveLog();
        }, 1000); // 1秒間隔で保存
    }

    // ログの保存
    private saveLog(): void {
        if (!this.logFile || this.isSaving) return;

        this.isSaving = true;
        
        const logData = {
            studentId: this.studentId,
            sessionId: this.sessionId,
            fileName: this.currentDocument,
            editLog: this.editLog,
            errorLog: this.errorLog,
            executionLog: this.executionLog
        };

        try {
            const ext = path.extname(this.logFile);
            const baseName = path.basename(this.logFile, ext);
            const dirName = path.dirname(this.logFile);
            let partNumber = 1;
            let logFilePath = path.join(dirName, `${baseName}_part${partNumber}${ext}`);

            // ログファイルサイズをチェックし、1MBを超えたら新しいファイルを作成
            while (fs.existsSync(logFilePath) && fs.statSync(logFilePath).size > 1024 * 1024) {
                partNumber++;                
                logFilePath = path.join(dirName, `${baseName}_part${partNumber}${ext}`);
            }

            //fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2), 'utf8');
            fs.writeFile(logFilePath, JSON.stringify(logData, null, 2), 'utf8', (err) => {
                if (err) console.error('ログファイル書き込みエラー:', err);
            });
        } catch (error) {
            console.error('Failed to save log:', error);
        } finally {
            this.isSaving = false;
        }
    }
}

// Python実行用のランナークラス
class PythonRunner {
    private logger: Logger;
    private outputChannel: vscode.OutputChannel;

    constructor(logger: Logger) {
        this.logger = logger;
        this.outputChannel = vscode.window.createOutputChannel('Python Execution Log');
    }

    // Pythonファイルを実行
    public async runPythonFile(filePath: string): Promise<void> {
        // ファイルが存在するか確認
        if (!fs.existsSync(filePath)) {
            vscode.window.showErrorMessage(`ファイルが見つかりません: ${filePath}`);
            return;
        }

        // Pythonファイルでない場合は実行しない
        if (!filePath.toLowerCase().endsWith('.py')) {
            vscode.window.showInformationMessage('Pythonファイルではありません。');
            return;
        }

        // 出力チャンネルをクリアして表示
        this.outputChannel.clear();
        this.outputChannel.show(true);
        this.outputChannel.appendLine(`実行中: ${filePath}`);
        this.outputChannel.appendLine("----------------------------------------");

        try {
            // Python実行開始ログ
            this.logger.startPythonExecution(filePath);

            // ファイルのディレクトリを取得
            const fileDir = path.dirname(filePath);

            // ファイル名を取得
            const fileName = path.basename(filePath);

            // Python実行コマンドの取得
            const pythonPath = vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath') || 'python';
            
            // 子プロセスとして実行
            const process = cp.spawn(pythonPath, [fileName], {
                cwd: fileDir,
                shell: true,
                env: { PYTHONIOENCODING: 'utf8' },
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            // プロセスをロガーに設定
            this.logger.setPythonProcess(process);

            // 標準出力をリッスン
            process.stdout.on('data', (data: Buffer) => {
                const output = data.toString();
                this.outputChannel.append(output);
            });

            // 標準エラー出力をリッスン
            process.stderr.on('data', (data: Buffer) => {
                const error = data.toString();
                this.outputChannel.append(error);
            });

            // プロセス終了イベント
            process.on('exit', (code: number | null) => {
                this.outputChannel.appendLine("----------------------------------------");
                this.outputChannel.appendLine(`\n終了コード: ${code || 0}`);
                if (code === 0) {
                    this.outputChannel.appendLine('正常に終了しました。');
                } else {
                    this.outputChannel.appendLine('エラーが発生しました。');
                }
            });

            // エラーイベント
            process.on('error', (err: Error) => {
                this.outputChannel.appendLine(`\nエラー: ${err.message}`);
                vscode.window.showErrorMessage(`Python実行エラー: ${err.message}`);
            });
        } catch (error: any) {
            this.outputChannel.appendLine(`\n実行エラー: ${error.message}`);
            vscode.window.showErrorMessage(`Python実行エラー: ${error.message}`);
        }
    }
}

// 拡張機能のアクティベーション
export function activate(context: vscode.ExtensionContext) {
    console.log('Logger extension is now active!');

    const logger = new Logger();
    const pythonRunner = new PythonRunner(logger);

    // ドキュメント変更イベントの監視
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(e => {
            // Pythonファイル以外は無視
            if (e.document.languageId !== 'python' || logger.shouldIgnoreDocument(e.document)) {
                return;
            }

            logger.onDocumentChange(e.document);
            e.contentChanges.forEach(change => {               

                // キー入力の検知
                if (change.text.length >= 1 && change.rangeLength > 0) {
                    logger.logEdit(change, e.document);
                }
                else if (change.text.length === 1 && change.rangeLength === 0) {
                    // 単一文字の追加はキー入力
                    logger.logKeyInput(change.text, e.document);
                } 
                else if (change.text === '' && change.rangeLength === 1) {
                    // 1文字の削除 => Delete
                    logger.logKeyInput('Delete', e.document);
                } 
                else if (change.text === '\n' || change.text === '\r\n') {
                    // 改行の追加 => Enterキー
                    logger.logKeyInput('Enter', e.document);
                }
            });
        })
    );

    // 選択範囲の変更イベントの監視
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => {
            const document = e.textEditor.document;
            if (document) {
                //logger.onDocumentChange(document);
            }
        })
    );

    // Python実行コマンドの登録
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.logger.runPython', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                // 現在のファイルを実行
                await pythonRunner.runPythonFile(activeEditor.document.fileName);
            } else {
                vscode.window.showInformationMessage('ファイルが開かれていません。');
            }
        })
    );

    // VSCodeの「Run Python File」ボタンをオーバーライドするために、
    // コンテキストメニューやエディタのタイトルバーに独自の再生ボタンを追加
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.logger.runPythonInTerminal', async () => {
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && activeEditor.document.languageId === 'python') {
                // ドキュメントを保存
                await activeEditor.document.save();
                // Pythonファイル実行
                await pythonRunner.runPythonFile(activeEditor.document.fileName);
            }
        })
    );

    // エディタ上部の「実行」ボタンを追加
    const runButtonDisposable = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        100
    );
    runButtonDisposable.text = "$(play) Python実行";
    runButtonDisposable.tooltip = "Pythonファイルを実行";
    runButtonDisposable.command = 'extension.logger.runPythonInTerminal';
    context.subscriptions.push(runButtonDisposable);

    // Pythonファイルがアクティブな場合にのみボタンを表示
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor && editor.document.languageId === 'python') {
                runButtonDisposable.show();
            } else {
                runButtonDisposable.hide();
            }
        })
    );

    // 初期状態の設定
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document.languageId === 'python') {
        runButtonDisposable.show();
    } else {
        runButtonDisposable.hide();
    }

    // 生徒ID設定コマンド
    context.subscriptions.push(
        vscode.commands.registerCommand('extension.logger.setStudentId', async () => {
            const studentId = await vscode.window.showInputBox({
                prompt: "Enter Student ID",
                placeHolder: "e.g., 12345"
            });
            
            if (studentId) {
                await vscode.workspace.getConfiguration('Logger').update('studentId', studentId, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`Student ID set to: ${studentId}`);
                logger.loadStudentId();
            }
        })
    );    

    // 統計表示コマンドの登録
    const statsDisposable = vscode.commands.registerCommand('extension.logger.showStats', () => {
        vscode.window.showInformationMessage('Logger is active. Logs are being collected.');
    });

    context.subscriptions.push(statsDisposable);
}

// 拡張機能の非アクティベーション
export function deactivate() {
    console.log('Logger extension is now deactivated.');
}