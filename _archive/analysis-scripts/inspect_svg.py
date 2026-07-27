with open(r"C:\Users\USER\Desktop\DIVE_2026\code\frontend-react\public\busan_subway_map.svg", "rb") as f:
    data = f.read(5000)
    print("First 5000 bytes:")
    print(data[:500].decode("utf-8", errors="ignore"))
    print("\nContains 'text'?", b"<text" in data or b"<tspan" in data)
    print("Contains 'path'?", b"<path" in data)
    print("Contains 'circle'?", b"<circle" in data)
    
# Let's search for some korean chars in the file by reading it all with utf-8
with open(r"C:\Users\USER\Desktop\DIVE_2026\code\frontend-react\public\busan_subway_map.svg", "r", encoding="utf-8", errors="ignore") as f:
    content = f.read()
    print("Total length:", len(content))
    print("Does it contain '<text' anywhere?", "<text" in content)
    # Search for some station names
    for name in ["서면", "부산", "Haeundae", "Seomyeon"]:
        print(f"Contains '{name}'?", name in content)
