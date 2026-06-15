//go:build linux

// nexus-screen-linux — captura X11 + injeção de input via xdotool para Nexus RMM
// Serve WebSocket local em 127.0.0.1:7701 com o mesmo protocolo do nexus-screen.exe.
//
// Requisitos:
//   - Sessão X11 ativa (DISPLAY=:0 ou similar)
//   - xdotool instalado: apt install xdotool  /  dnf install xdotool
//
// Frames (binário, helper → relay → viewer):
//
//	[0x01][4B width LE][4B height LE][JPEG data]
//
// Comandos (JSON, viewer → relay → helper):
//
//	{"cmd":"mouse","x":0.5,"y":0.3,"buttons":1}
//	{"cmd":"mouseup","buttons":1}
//	{"cmd":"scroll","x":0.5,"y":0.3,"delta":-3}
//	{"cmd":"key","vk":65,"down":true}
//	{"cmd":"qualidade","q":75}
//	{"cmd":"monitor","idx":0}
//	{"cmd":"fps","v":30}
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/kbinani/screenshot"
)

// ── estado global ─────────────────────────────────────────────────────────────

type captureState struct {
	mu      sync.RWMutex
	quality int
	fps     int
	monIdx  int
}

var state = &captureState{quality: 65, fps: 15, monIdx: 0}

var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

// ── main ──────────────────────────────────────────────────────────────────────

func main() {
	// Garante DISPLAY configurado
	if os.Getenv("DISPLAY") == "" {
		os.Setenv("DISPLAY", ":0")
		log.Println("[nexus-screen-linux] DISPLAY não definida, usando :0")
	}
	if os.Getenv("XAUTHORITY") == "" {
		// Tenta cookie padrão do usuário logado
		home, _ := os.UserHomeDir()
		if home != "" {
			os.Setenv("XAUTHORITY", home+"/.Xauthority")
		}
	}

	port := "127.0.0.1:7701"
	if len(os.Args) > 1 {
		port = os.Args[1]
	}
	log.SetFlags(log.Ltime | log.Lshortfile)
	log.Printf("nexus-screen-linux iniciando em ws://%s", port)

	n := screenshot.NumActiveDisplays()
	log.Printf("monitores X11: %d", n)
	for i := 0; i < n; i++ {
		b := screenshot.GetDisplayBounds(i)
		log.Printf("  [%d] %dx%d @ (%d,%d)", i, b.Dx(), b.Dy(), b.Min.X, b.Min.Y)
	}

	// Verifica xdotool
	if _, err := exec.LookPath("xdotool"); err != nil {
		log.Println("[AVISO] xdotool não encontrado — input remoto desabilitado. Instale: apt install xdotool")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handleWS)
	mux.HandleFunc("/monitores", handleMonitores)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })

	ln, err := net.Listen("tcp", port)
	if err != nil {
		log.Fatalf("porta %s indisponível: %v", port, err)
	}
	log.Printf("✓ ouvindo em %s", port)
	if err := http.Serve(ln, mux); err != nil {
		log.Fatal(err)
	}
}

// ── /monitores ────────────────────────────────────────────────────────────────

func handleMonitores(w http.ResponseWriter, r *http.Request) {
	n := screenshot.NumActiveDisplays()
	type mon struct {
		Idx int `json:"idx"`
		W   int `json:"w"`
		H   int `json:"h"`
		X   int `json:"x"`
		Y   int `json:"y"`
	}
	lista := make([]mon, 0, n)
	for i := 0; i < n; i++ {
		b := screenshot.GetDisplayBounds(i)
		lista = append(lista, mon{i, b.Dx(), b.Dy(), b.Min.X, b.Min.Y})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(lista)
}

// ── /ws ───────────────────────────────────────────────────────────────────────

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}
	defer conn.Close()
	log.Println("viewer conectado")

	cmdCh := make(chan map[string]interface{}, 16)
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				close(cmdCh)
				return
			}
			var cmd map[string]interface{}
			if json.Unmarshal(msg, &cmd) == nil {
				cmdCh <- cmd
			}
		}
	}()

	state.mu.RLock()
	ticker := time.NewTicker(time.Second / time.Duration(state.fps))
	state.mu.RUnlock()
	defer ticker.Stop()

	var lastHash uint64
	var prevButtons float64

	for {
		select {
		case cmd, ok := <-cmdCh:
			if !ok {
				log.Println("viewer desconectado")
				return
			}
			handleCmd(cmd, ticker, &prevButtons)

		case <-ticker.C:
			state.mu.RLock()
			q := state.quality
			idx := state.monIdx
			state.mu.RUnlock()

			img, err := captureMonitor(idx)
			if err != nil || img == nil {
				continue
			}
			h := quickHash(img)
			if h == lastHash {
				continue
			}
			lastHash = h

			frame, err := encodeJPEG(img, q)
			if err != nil {
				continue
			}
			pkt := buildPacket(img.Bounds().Dx(), img.Bounds().Dy(), frame)
			if err := conn.WriteMessage(websocket.BinaryMessage, pkt); err != nil {
				log.Printf("send: %v", err)
				return
			}
		}
	}
}

// ── captura ───────────────────────────────────────────────────────────────────

func captureMonitor(idx int) (*image.RGBA, error) {
	n := screenshot.NumActiveDisplays()
	if n == 0 {
		return nil, fmt.Errorf("nenhum display X11 disponível (DISPLAY=%s)", os.Getenv("DISPLAY"))
	}
	if idx < 0 || idx >= n {
		idx = 0
	}
	return screenshot.CaptureDisplay(idx)
}

// ── encode ────────────────────────────────────────────────────────────────────

func encodeJPEG(img image.Image, quality int) ([]byte, error) {
	var buf bytes.Buffer
	err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality})
	return buf.Bytes(), err
}

func buildPacket(w, h int, jpegData []byte) []byte {
	pkt := make([]byte, 9+len(jpegData))
	pkt[0] = 0x01
	binary.LittleEndian.PutUint32(pkt[1:5], uint32(w))
	binary.LittleEndian.PutUint32(pkt[5:9], uint32(h))
	copy(pkt[9:], jpegData)
	return pkt
}

// ── hash ──────────────────────────────────────────────────────────────────────

func quickHash(img *image.RGBA) uint64 {
	if img == nil {
		return 0
	}
	const (
		offset = 14695981039346656037
		prime  = 1099511628211
	)
	h := uint64(offset)
	pix := img.Pix
	for i := 0; i < len(pix); i += 64 {
		h ^= uint64(pix[i])
		h *= prime
	}
	return h
}

// ── input via xdotool ─────────────────────────────────────────────────────────

// xdo executa xdotool de forma assíncrona (não bloqueia o event loop).
func xdo(args ...string) {
	cmd := exec.Command("xdotool", args...)
	cmd.Env = append(os.Environ(),
		"DISPLAY="+os.Getenv("DISPLAY"),
		"XAUTHORITY="+os.Getenv("XAUTHORITY"),
	)
	_ = cmd.Start()
	go func() { _ = cmd.Wait() }()
}

// vkToXdoKey converte Virtual Key code Windows para nome de tecla do xdotool.
func vkToXdoKey(vk int) string {
	switch vk {
	case 0x08:
		return "BackSpace"
	case 0x09:
		return "Tab"
	case 0x0D:
		return "Return"
	case 0x10:
		return "Shift_L"
	case 0x11:
		return "Control_L"
	case 0x12:
		return "Alt_L"
	case 0x1B:
		return "Escape"
	case 0x20:
		return "space"
	case 0x21:
		return "Prior" // Page Up
	case 0x22:
		return "Next" // Page Down
	case 0x23:
		return "End"
	case 0x24:
		return "Home"
	case 0x25:
		return "Left"
	case 0x26:
		return "Up"
	case 0x27:
		return "Right"
	case 0x28:
		return "Down"
	case 0x2E:
		return "Delete"
	case 0x30:
		return "0"
	case 0x31:
		return "1"
	case 0x32:
		return "2"
	case 0x33:
		return "3"
	case 0x34:
		return "4"
	case 0x35:
		return "5"
	case 0x36:
		return "6"
	case 0x37:
		return "7"
	case 0x38:
		return "8"
	case 0x39:
		return "9"
	case 0x41:
		return "a"
	case 0x42:
		return "b"
	case 0x43:
		return "c"
	case 0x44:
		return "d"
	case 0x45:
		return "e"
	case 0x46:
		return "f"
	case 0x47:
		return "g"
	case 0x48:
		return "h"
	case 0x49:
		return "i"
	case 0x4A:
		return "j"
	case 0x4B:
		return "k"
	case 0x4C:
		return "l"
	case 0x4D:
		return "m"
	case 0x4E:
		return "n"
	case 0x4F:
		return "o"
	case 0x50:
		return "p"
	case 0x51:
		return "q"
	case 0x52:
		return "r"
	case 0x53:
		return "s"
	case 0x54:
		return "t"
	case 0x55:
		return "u"
	case 0x56:
		return "v"
	case 0x57:
		return "w"
	case 0x58:
		return "x"
	case 0x59:
		return "y"
	case 0x5A:
		return "z"
	case 0x5B:
		return "super" // Win key
	case 0x70:
		return "F1"
	case 0x71:
		return "F2"
	case 0x72:
		return "F3"
	case 0x73:
		return "F4"
	case 0x74:
		return "F5"
	case 0x75:
		return "F6"
	case 0x76:
		return "F7"
	case 0x77:
		return "F8"
	case 0x78:
		return "F9"
	case 0x79:
		return "F10"
	case 0x7A:
		return "F11"
	case 0x7B:
		return "F12"
	case 0xA0:
		return "Shift_L"
	case 0xA1:
		return "Shift_R"
	case 0xA2:
		return "Control_L"
	case 0xA3:
		return "Control_R"
	case 0xA4:
		return "Alt_L"
	case 0xA5:
		return "Alt_R"
	case 0xBB:
		return "equal" // =
	case 0xBD:
		return "minus" // -
	case 0xBE:
		return "period" // .
	case 0xBF:
		return "slash"
	case 0xC0:
		return "grave" // `
	case 0xDB:
		return "bracketleft"
	case 0xDC:
		return "backslash"
	case 0xDD:
		return "bracketright"
	case 0xDE:
		return "apostrophe"
	default:
		return ""
	}
}

// ── comandos ──────────────────────────────────────────────────────────────────

func handleCmd(cmd map[string]interface{}, ticker *time.Ticker, prevButtons *float64) {
	c, _ := cmd["cmd"].(string)

	switch c {
	case "qualidade":
		if v, ok := cmd["q"].(float64); ok && v >= 1 && v <= 95 {
			state.mu.Lock()
			state.quality = int(v)
			state.mu.Unlock()
		}

	case "monitor":
		if v, ok := cmd["idx"].(float64); ok {
			state.mu.Lock()
			state.monIdx = int(v)
			state.mu.Unlock()
		}

	case "fps":
		if v, ok := cmd["v"].(float64); ok && v >= 1 && v <= 60 {
			state.mu.Lock()
			state.fps = int(v)
			dur := time.Second / time.Duration(state.fps)
			state.mu.Unlock()
			ticker.Reset(dur)
		}

	case "mouse":
		relX, _ := cmd["x"].(float64)
		relY, _ := cmd["y"].(float64)
		buttons, _ := cmd["buttons"].(float64)

		state.mu.RLock()
		idx := state.monIdx
		state.mu.RUnlock()

		n := screenshot.NumActiveDisplays()
		if idx < 0 || idx >= n {
			idx = 0
		}
		mon := screenshot.GetDisplayBounds(idx)

		absX := int(relX*float64(mon.Dx())) + mon.Min.X
		absY := int(relY*float64(mon.Dy())) + mon.Min.Y

		xdo("mousemove", "--sync", fmt.Sprintf("%d", absX), fmt.Sprintf("%d", absY))

		prev := *prevButtons
		*prevButtons = buttons

		// Botão esquerdo (bit 0)
		if int(buttons)&1 != 0 && int(prev)&1 == 0 {
			xdo("mousedown", "1")
		} else if int(buttons)&1 == 0 && int(prev)&1 != 0 {
			xdo("mouseup", "1")
		}
		// Botão direito (bit 1)
		if int(buttons)&2 != 0 && int(prev)&2 == 0 {
			xdo("mousedown", "3")
		} else if int(buttons)&2 == 0 && int(prev)&2 != 0 {
			xdo("mouseup", "3")
		}
		// Botão do meio (bit 2)
		if int(buttons)&4 != 0 && int(prev)&4 == 0 {
			xdo("mousedown", "2")
		} else if int(buttons)&4 == 0 && int(prev)&4 != 0 {
			xdo("mouseup", "2")
		}

	case "mouseup":
		buttons, _ := cmd["buttons"].(float64)
		*prevButtons = 0
		if int(buttons)&1 != 0 {
			xdo("mouseup", "1")
		}
		if int(buttons)&2 != 0 {
			xdo("mouseup", "3")
		}
		if int(buttons)&4 != 0 {
			xdo("mouseup", "2")
		}

	case "scroll":
		delta, _ := cmd["delta"].(float64)
		relX, _ := cmd["x"].(float64)
		relY, _ := cmd["y"].(float64)

		state.mu.RLock()
		idx := state.monIdx
		state.mu.RUnlock()

		n := screenshot.NumActiveDisplays()
		if idx < 0 || idx >= n {
			idx = 0
		}
		mon := screenshot.GetDisplayBounds(idx)
		absX := int(relX*float64(mon.Dx())) + mon.Min.X
		absY := int(relY*float64(mon.Dy())) + mon.Min.Y
		xdo("mousemove", fmt.Sprintf("%d", absX), fmt.Sprintf("%d", absY))

		btn := "4" // scroll up
		if delta < 0 {
			btn = "5" // scroll down
		}
		count := int(delta)
		if count < 0 {
			count = -count
		}
		if count == 0 {
			count = 1
		}
		for i := 0; i < count; i++ {
			xdo("click", btn)
		}

	case "key":
		vk, _ := cmd["vk"].(float64)
		down, _ := cmd["down"].(bool)
		key := vkToXdoKey(int(vk))
		if key == "" {
			return
		}
		if down {
			xdo("keydown", key)
		} else {
			xdo("keyup", key)
		}
	}
}
