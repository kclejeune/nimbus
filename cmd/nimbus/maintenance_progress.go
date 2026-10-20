package main

import (
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"github.com/charmbracelet/x/term"
)

// A maintenance request can spend seconds probing upstreams or walking SQL
// closures. Keep a heartbeat on terminals and plain stage counters in logs.
type maintenanceProgress struct {
	out   io.Writer
	mu    sync.Mutex
	label string
	stop  chan struct{}
	done  chan struct{}
}

func newMaintenanceProgress(out io.Writer) *maintenanceProgress {
	p := &maintenanceProgress{out: out}
	if f, ok := out.(*os.File); ok && term.IsTerminal(f.Fd()) && os.Getenv("TERM") != "dumb" {
		p.stop = make(chan struct{})
		p.done = make(chan struct{})
		go func() {
			defer close(p.done)
			ticker := time.NewTicker(150 * time.Millisecond)
			defer ticker.Stop()
			start := time.Now()
			frame := 0
			for {
				select {
				case <-p.stop:
					return
				case <-ticker.C:
					p.mu.Lock()
					fmt.Fprintf(
						p.out,
						"\r\x1b[2K%c %s (%s)",
						"|/-\\"[frame%4],
						p.label,
						time.Since(start).Round(time.Second),
					)
					p.mu.Unlock()
					frame++
				}
			}
		}()
	}
	return p
}

func (p *maintenanceProgress) update(format string, args ...any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.label = fmt.Sprintf(format, args...)
	if p.stop == nil {
		fmt.Fprintln(p.out, p.label)
	} else {
		fmt.Fprintf(p.out, "\r\x1b[2K%s", p.label)
	}
}

func (p *maintenanceProgress) close() {
	if p.stop != nil {
		close(p.stop)
		<-p.done
		fmt.Fprintf(p.out, "\r\x1b[2K%s\n", p.label)
		p.stop = nil
	}
}
