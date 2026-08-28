// Orchestrator tray process — pure-Go systray via gogpu/systray (zero CGO).
//
// IPC protocol (one JSON line per message):
//
//	Node → Go (stdin):
//	  { "type": "init",     "menu": MenuSnapshot }
//	  { "type": "set-menu", "menu": MenuSnapshot }
//	  { "type": "exit" }
//
//	Go → Node (stdout):
//	  { "type": "ready" }
//	  { "type": "clicked", "id": "<opaque id>" }
//
// MenuSnapshot = { "icon": "<base64 PNG>", "isTemplateIcon": bool, "tooltip": "...", "items": [...] }
// MenuItemSnapshot = { "id": "...", "type": "normal"|"separator", "title": "...", "enabled": bool, "checked": bool }
package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/gogpu/systray"
)

// version is injected at build time via -ldflags "-X main.version=<value>".
var version = "dev"

func logf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[tray-go] %s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
}

// stdoutMu serialises all writes to os.Stdout: the ready message (written
// from the stdin goroutine) and clicked messages (written from menu item
// callbacks, which run on the Win32 message-loop thread).
var stdoutMu sync.Mutex

func writeJSON(v interface{}) {
	data, err := json.Marshal(v)
	if err != nil {
		logf("writeJSON marshal error: %v", err)
		return
	}
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	data = append(data, '\n')
	_, _ = os.Stdout.Write(data)
}

// --- IPC message types: Node → Go (stdin) ---

// ipcMessage is the envelope for all stdin messages.
type ipcMessage struct {
	Type string        `json:"type"`
	Menu *menuSnapshot `json:"menu,omitempty"`
}

// menuSnapshot is a complete description of the desired tray state sent by Node.
type menuSnapshot struct {
	Icon           string             `json:"icon"`
	IsTemplateIcon bool               `json:"isTemplateIcon"`
	Tooltip        string             `json:"tooltip"`
	Items          []menuItemSnapshot `json:"items"`
}

// menuItemSnapshot describes a single menu item.
type menuItemSnapshot struct {
	ID      string `json:"id"`
	Type    string `json:"type"` // "normal" | "separator"
	Title   string `json:"title"`
	Enabled bool   `json:"enabled"`
	Checked bool   `json:"checked,omitempty"`
}

// --- IPC message types: Go → Node (stdout) ---

type readyMsg struct {
	Type string `json:"type"`
}

type clickedMsg struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

// --- Core helpers ---

// readIPCMessage reads one newline-delimited JSON line from reader into v.
func readIPCMessage(reader *bufio.Reader, v interface{}) error {
	line, err := reader.ReadString('\n')
	if err != nil {
		return err
	}
	if len(line) < 2 {
		return fmt.Errorf("empty line")
	}
	return json.Unmarshal([]byte(line[:len(line)-1]), v)
}

// buildMenu converts a slice of MenuItemSnapshot into a gogpu/systray Menu.
// Each enabled normal item's onClick closure emits a clicked message carrying
// the item's opaque ID — no positional index, no title-matching.
// Disabled items are added with a nil callback (non-interactive but visible).
func buildMenu(items []menuItemSnapshot) *systray.Menu {
	menu := systray.NewMenu()
	for _, item := range items {
		item := item // per-iteration capture
		switch item.Type {
		case "separator":
			menu.AddSeparator()
		default:
			onClick := (func())(nil)
			if item.Enabled {
				id := item.ID
				onClick = func() {
					logf("clicked id=%q", id)
					writeJSON(clickedMsg{Type: "clicked", ID: id})
				}
			}
			if item.Checked {
				menu.AddCheckbox(item.Title, true, onClick)
			} else {
				menu.Add(item.Title, onClick)
			}
		}
	}
	return menu
}

// applySnapshot pushes a full MenuSnapshot to the tray: icon, tooltip, and menu.
func applySnapshot(tray *systray.SystemTray, snap *menuSnapshot) {
	iconBytes, err := base64.StdEncoding.DecodeString(snap.Icon)
	if err != nil {
		logf("failed to decode icon: %v", err)
	} else if len(iconBytes) > 0 {
		logf("SetIcon called: %d bytes, isTemplateIcon=%v", len(iconBytes), snap.IsTemplateIcon)
		if snap.IsTemplateIcon {
			tray.SetTemplateIcon(iconBytes)
		} else {
			tray.SetIcon(iconBytes)
		}
		logf("SetIcon returned")
	}
	tray.SetTooltip(snap.Tooltip)
	tray.SetMenu(buildMenu(snap.Items))
}

func main() {
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *versionFlag {
		fmt.Println(version)
		return
	}

	logf("starting tray-go version=%s", version)

	tray := systray.New()

	// Forward SIGTERM/SIGINT to a clean exit.
	// tray.Remove() is intentionally skipped here: on macOS, Cocoa's removeStatusItem
	// must be called from the main thread; calling it from a signal goroutine causes a
	// SIGSEGV. The OS removes the status item automatically when the process exits.
	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		logf("signal %v received, exiting", sig)
		os.Exit(0)
	}()

	// Stdin goroutine: read init, configure the tray, emit ready, then loop.
	// Starts before tray.Run() so it can configure the tray before the
	// message loop begins — no ready/write race.
	go func() {
		reader := bufio.NewReader(os.Stdin)

		// Emit ready first so Node can send init.  The plan specifies:
		//   Go → Node: { type: 'ready' }
		//   Node → Go: { type: 'init', menu: ... }   (just after "ready")
		// Emitting before the blocking readIPCMessage call ensures Node's
		// tp.ready().then(() => tp.send({type:'init',...})) is not deadlocked
		// waiting for a ready that only arrives after init is read.
		writeJSON(readyMsg{Type: "ready"})
		logf("ready event emitted")

		var msg ipcMessage
		if err := readIPCMessage(reader, &msg); err != nil {
			logf("failed to read init message: %v", err)
			os.Exit(1)
		}
		if msg.Type != "init" || msg.Menu == nil {
			logf("expected init message, got type=%q", msg.Type)
			os.Exit(1)
		}
		logf("init received: tooltip=%q items=%d", msg.Menu.Tooltip, len(msg.Menu.Items))

		applySnapshot(tray, msg.Menu)
		tray.Show()

		for {
			var m ipcMessage
			if err := readIPCMessage(reader, &m); err != nil {
				logf("stdin read error (driver likely exited): %v", err)
				os.Exit(0)
			}
			logf("message received: type=%q", m.Type)
			switch m.Type {
			case "set-menu":
				if m.Menu != nil {
					applySnapshot(tray, m.Menu)
				}
			case "exit":
				logf("exit requested")
				os.Exit(0)
			default:
				logf("unknown message type=%q, ignoring", m.Type)
			}
		}
	}()

	if err := tray.Run(); err != nil {
		logf("tray.Run() error: %v", err)
		os.Exit(1)
	}
	logf("exiting")
}
